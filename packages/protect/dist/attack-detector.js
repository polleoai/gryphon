"use strict";
// TypeScript module marker.
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Attack detector — single enforcement point for Gryphon's
 * protected-pattern defense. Both SDK tools and (later) the CLI
 * provider's permission_request handler route through this module.
 *
 * Design rationale in docs/v0.5.0-attack-detector-design.md.
 *
 * Responsibility scope — the detector only knows about patterns that
 * appear in the active protected-paths / protected-commands lists.
 * It does NOT scan content, track provenance, or make decisions
 * beyond "is this tool_use one of the user's flagged patterns."
 * Anything more is out of Gryphon's scope and is documented as
 * tool calls only; downstream threat intel is a separate concern.
 */
const path = require("path");
const fs = require("fs");
const { DEFAULT_PROTECTED_PATHS, DEFAULT_PROTECTED_COMMANDS, PROTECTED_CATEGORIES, } = require("./constants");
const { matchProtectedPath, resolveVaultPath, PathOutsideVaultError, } = require("./path-utils");
const { checkPermission } = require("./permission-gate");
const { approvalsStoreVerdict, normalizeForMatch } = require("./mcp-approvals");
const { securityInputsOf } = require("./security-settings-store");
/**
 * Per-pattern de-duplication so a user with one broken regex doesn't
 * get a Notice / console warning on every classify call. First time
 * we see a bad pattern → warn loudly; subsequent classifies silently
 * skip it. Reset on plugin reload (module cache clears).
 *
 * @param {string}      pattern     — the offending regex string
 * @param {Error}       err         — compile error
 * @param {object|null} hostAdapter — optional duck-type {notify(msg, opts?)}
 *   supplied by the plugin shell (Task 0.6). When present, the warning is
 *   surfaced as an Obsidian toast via hostAdapter.notify; when absent (headless
 *   callers, hook scripts, tests), console.error is the only output — callers
 *   that don't pass hostAdapter have opted out of UI notifications.
 */
const _warnedBadPatterns = new Set();
function _warnInvalidPatternOnce(pattern, err, hostAdapter) {
    if (_warnedBadPatterns.has(pattern))
        return;
    _warnedBadPatterns.add(pattern);
    const msg = `Gryphon: custom protected pattern "${pattern}" is not a valid regex ` +
        `(${(err && err.message) || err}). That rule is NOT enforcing — ` +
        `fix it in Settings → Gryphon → Protected commands or Protected file paths.`;
    try {
        console.error("[gryphon/classifier]", msg);
    }
    catch (_) { }
    if (hostAdapter && typeof hostAdapter.notify === "function") {
        hostAdapter.notify(msg, { level: "warn", timeoutMs: 15000 });
    }
    // else: silently drop UI notification — a headless caller that doesn't pass
    // hostAdapter has opted out of UI toasts; console.error above is sufficient.
}
/**
 * Merge the user's disabled + custom settings with the built-in defaults
 * and return the set of active pattern definitions, each still carrying
 * its category / userRisk / explanation metadata. Mirrors
 * `resolveActivePatterns` in path-utils but preserves the metadata fields
 * (that function returns plain strings for regex compilation).
 */
function _activePatternDefs(defaults, disabled, custom) {
    const defs = Array.isArray(defaults) ? defaults : [];
    const off = new Set(Array.isArray(disabled) ? disabled : []);
    const normalizedDefs = defs
        .map((d) => {
        if (typeof d === "string")
            return { pattern: d };
        if (d && typeof d.pattern === "string")
            return d;
        return null;
    })
        .filter((d) => d && !off.has(d.pattern));
    const custs = Array.isArray(custom)
        ? custom
            .filter((p) => typeof p === "string" && p.length > 0)
            .map((p) => ({
            pattern: p,
            category: "user-custom",
            userRisk: `This matches a pattern you added to Gryphon's protected list (\`${p}\`). ` +
                `Gryphon is prompting because the tool call looked like what you told it to watch for.`,
            explanation: "User-added pattern.",
        }))
        : [];
    return [...normalizedDefs, ...custs];
}
function _categoryTitle(category) {
    return PROTECTED_CATEGORIES[category] || "⚠ Matches a protected pattern";
}
/**
 * Classify a proposed tool invocation against the user's active
 * protected-pattern list.
 *
 * @param {string} tool  — "Write" | "Edit" | "Bash" | "PowerShell" | other
 * @param {object} input — tool input object (same shape as tool_use.input)
 * @param {object} ctx   — { vaultRoot, plugin, ... }
 * @returns {object|null}
 *   null if no protected pattern matched; otherwise:
 *   { tool, matchedPattern, category, title, userRisk, technicalDetail }
 */
/**
 * Cross-CLI tool-name aliases (issue #30: their own module, so the bundled
 * store-guard hook canonicalises tool names exactly as classify does).
 */
const { TOOL_ALIASES, patchTargetsInfo, shellCdDirs } = require("./tool-aliases");
const { rebaseOntoRoot } = require("./path-identity");
function classify(tool, input, ctx) {
    if (!tool || !input)
        return null;
    // Issue #29: the frozen security snapshot (ctx.security) wins. Without
    // one, the caller's own settings (ctx.settings, then ctx.plugin.settings)
    // are used — the headless-library form. Gryphon's own callers always pass
    // a snapshot, so a vault's data.json is never an input here.
    const security = securityInputsOf(ctx);
    // Normalize provider-specific tool names to the Claude-Code vocabulary
    // the per-tool branches below understand. Unknown names pass through
    // and hit the "not currently gated" branch (correct default).
    const canonical = TOOL_ALIASES[tool] || tool;
    // NotebookEdit names its target `notebook_path`; the file branch reads
    // `file_path`.
    if (typeof input.file_path !== "string" && typeof input.notebook_path === "string") {
        input = { ...input, file_path: input.notebook_path };
    }
    // Issue #25: the vault-MCP approval store. Checked before every master
    // toggle on purpose — it's a fixed invariant, not a user pattern — and
    // for ANY tool that isn't read-only, so a tool missing from TOOL_ALIASES
    // can't write it by default. Path-like and command-like arguments are
    // both checked, nested ones included (issue #28).
    // Issue #30: one rule, shared with the store-guard hook (approvalsStoreVerdict).
    const vaultRoot = ctx && typeof ctx.vaultRoot === "string" ? ctx.vaultRoot : null;
    const store = approvalsStoreVerdict(tool, input, { cwd: vaultRoot });
    if (store)
        return _approvalsStoreVerdict(canonical, store.what);
    if (canonical === "Write" || canonical === "Edit") {
        // Master toggle — when the user turns off Protected file paths
        // entirely, return null so gate() treats it as non-protected and
        // the normal permission-mode policy applies (Prompt/Safe/YOLO all
        // respected as the user chose for routine operations).
        if (security.protectedPathsEnabled === false)
            return null;
        // R43-3: Codex apply_patch carries its targets in the patch text; each
        // one is classified like a Write/Edit of that file, and the most severe
        // verdict wins (the others are named in its detail).
        if (tool === "apply_patch" && typeof input.file_path !== "string") {
            return _mostSevere(_patchVerdicts(canonical, input, ctx, security));
        }
        // Gemini's write_file uses `file_path` already, but `replace`
        // uses `file_path` too (Gemini's docs). _classifyFilePath reads
        // input.file_path; if a future CLI uses a different field, add
        // a normalizer here similar to TOOL_ALIASES.
        // #36 item 4: an aliased tool may name its target under another key
        // (agy `move` names a source and a destination) — every path-like
        // argument is checked too, not only `file_path`.
        const fp = _classifyFilePath(canonical, input, ctx, security);
        const others = _pathArgVerdicts(tool, input, ctx, security);
        return _mostSevere([...(fp ? [fp] : []), ...others]);
    }
    // "PowerShell" is CC's shell-command tool on Windows; it carries the
    // same `{command, description}` shape as Bash and needs the same
    // protected-pattern scan. Without this routing, Windows users got zero
    // protection on shell-style deletes (Remove-Item, del /s, format D:) —
    // CC's cwd-restriction happened to catch obvious cases but missed any
    // destructive command targeting a path inside the vault.
    if (canonical === "Bash" || canonical === "PowerShell") {
        // R43-3: a shell `apply_patch <<'EOF' … EOF` edits files Codex applies
        // itself; each patched file is classified as an Edit of that file.
        // Only the command's own text can be a shell `apply_patch`.
        const verdicts = security.protectedPathsEnabled !== false
            ? _patchVerdicts("Edit", { command: input.command }, ctx, security, input) : [];
        if (security.protectedPathsEnabled !== false)
            verdicts.push(..._shellPathVerdicts(canonical, input.command, ctx, security, input));
        if (security.protectedCommandsEnabled !== false) {
            const cmd = _classifyCommand(canonical, input, ctx, security);
            if (cmd)
                verdicts.unshift(cmd);
        }
        return _mostSevere(verdicts);
    }
    // Read / Glob / Grep / WebFetch / WebSearch are not gated — their
    // outputs carry the threat, not their inputs.
    if (UNGATED_TOOLS.has(canonical))
        return null;
    // #36 item 1: a tool whose name says it only reads (`get_file_contents`,
    // `list_directory`, `search_code`) is treated like Read — reading a
    // protected file is allowed, and a remote tool's repo-relative path
    // (`.git/config` on GitHub) isn't a vault file.
    // Review of f235334: only the PATH checks are skipped for such a tool —
    // a read-named tool can still run a command (`get_command_output {cmd}`).
    const readOnly = _readOnlyToolName(tool);
    // #34: any OTHER tool (a CLI tool Gryphon has no alias for yet — agy ships
    // 100+ — or an MCP tool) is gated by what it touches, not its name: every
    // path-like argument is classified as a write of that path. Only a
    // protected match yields a verdict, so ordinary tools stay unaffected.
    // Review of 7075f35: a read-named tool still has its destination-type
    // arguments checked (`get_file {local_path}` writes a local file).
    const verdicts = security.protectedPathsEnabled === false ? []
        : _pathArgVerdicts(tool, input, ctx, security, readOnly ? (k) => !_words(k).every((w) => LOCATOR_WORDS.has(w)) : undefined);
    // #36 item 3: command-like arguments (`{cmd: "rm -rf …"}`) get the same
    // protected-command and shell-path rules as Bash.
    const cmds = _commandArgs(input);
    if (cmds === null)
        return _mostSevere(_tooLargeVerdict(tool, "too many command arguments to inspect"));
    for (const { command, shell } of cmds) {
        if (security.protectedCommandsEnabled !== false) {
            // Prose and source code (`args`, `code`, `script`) get the destructive
            // and Gryphon rules; the prose-prone ones (`at`, `eval`, `source`,
            // `ssh`, `xargs`, installs) only on real shell-command arguments.
            const c = _classifyCommand(tool, { command: shell ? command : _withoutCodeIdioms(command) }, ctx, security, shell ? null : STRICT_COMMAND_CATEGORIES);
            if (c)
                verdicts.push(c);
        }
        if (security.protectedPathsEnabled !== false)
            verdicts.push(..._shellPathVerdicts(tool, command, ctx, security, input));
    }
    return _mostSevere(verdicts);
}
/** Split a tool or key name into lowercase words (camelCase, _, -, ., __). */
function _words(name) {
    return String(name || "").replace(/([a-z\d])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z\d]+/).filter(Boolean);
}
const READ_VERBS = new Set(["get", "list", "read", "search", "query", "view", "show", "describe", "find", "lookup", "grep", "glob", "stat", "count", "check", "inspect"]);
const WRITE_WORDS = new Set([
    "write", "create", "update", "delete", "remove", "rm", "move", "mv", "rename", "set", "put", "post", "edit", "append",
    "replace", "patch", "exec", "execute", "run", "apply", "upload", "download", "insert", "modify", "save", "copy", "cp",
    "mkdir", "make", "new", "add", "push", "commit", "merge", "install", "drop", "truncate", "overwrite", "chmod", "link",
    "unlink", "clear", "reset", "restore", "import", "export", "sync", "fork", "transfer", "send", "start", "stop", "kill",
]);
/** The tool's own (last) name starts with a read verb and has no write word. */
function _readOnlyToolName(tool) {
    const parts = String(tool || "").split("__");
    const own = parts.pop() || "";
    let words = _words(own);
    if (words.some((w) => WRITE_WORDS.has(w)))
        return false;
    // QA of 83183e6: a tool named after its server (`obsidian_list_files…` on
    // the `mcp-obsidian` server) starts with the server's words, not a verb.
    const server = new Set(parts.length > 1 ? _words(parts[parts.length - 1]) : []);
    while (words.length > 1 && server.has(words[0]))
        words = words.slice(1);
    if (!words.length || words.some((w) => WRITE_WORDS.has(w)))
        return false;
    // `directory_tree` / `tree` list a folder (not `checkout_tree`).
    return READ_VERBS.has(words[0]) || ["tree", "directory tree", "dir tree", "file tree", "folder tree"].includes(words.join(" "));
}
/**
 * A read-named tool skips a path key only when the key is a plain locator
 * (`path`, `filePath`, `dirpath`). Any other word — `dest`, `output`, or a
 * qualifier like `responseFilePath` (security review of 83183e6: a "get"
 * tool that saves a download there) — keeps the check.
 */
const LOCATOR_WORDS = new Set(["path", "paths", "file", "files", "filepath", "filepaths", "filename", "filenames", "uri", "uris", "url", "urls", "dir", "dirs", "directory", "directories", "dirpath", "dirname", "folder", "folders", "name", "relative", "absolute", "abs", "rel", "full",
    // Where a read or search starts (review of 81283ca): `cwd`, `root_path`, `search_path`, `SearchDirectory`.
    "cwd", "workdir", "working", "root", "base", "search", "start", "source", "src", "from", "in", "scope"]);
const DEST_WORDS = new Set(["dest", "dst", "destination", "destinations", "output", "out", "outfile", "outdir", "target", "targets", "to", "local", "save", "into"]);
const CONTENT_WORDS = new Set(["content", "contents", "text", "body", "data", "bytes", "blob", "snippet", "patch", "diff", "description", "message"]);
const NOT_PATH_WORDS = new Set(["profile", "profiles"]);
/**
 * #36 item 1: the store guard's path-key matcher, minus two false-positive
 * classes — a key whose LAST word says it holds content (`fileContent`,
 * `pathText`; but `dataPath` stays a path) and words that merely contain
 * "file" (`profile`). Review of f235334: anything narrower dropped real
 * path keys (`destinations`, `targetpath`, `workdir`).
 */
function _isPathKey(key) {
    const { PATH_ARG_RE } = require("./mcp-approvals");
    if (!PATH_ARG_RE.test(key))
        return false;
    const words = _words(key);
    if (words.length && CONTENT_WORDS.has(words[words.length - 1]))
        return false;
    const rest = words.filter((w) => !NOT_PATH_WORDS.has(w));
    return rest.some((w) => PATH_ARG_RE.test(w)) || PATH_ARG_RE.test(rest.join(""));
}
/**
 * Command-line strings among a tool's arguments (keys like cmd / command /
 * script). Null when there are more than can be checked (review of f235334:
 * the rest must not pass unchecked).
 */
const STRICT_COMMAND_CATEGORIES = new Set(["destructive-operation", "modifies-gryphon", "escalates-privileges", "network-exec", "modifies-editor", "accesses-system"]);
/**
 * Review of 83183e6: in source code (non-shell arguments) a statement
 * `del name` and a method call `.unlink(` are the language, not cmd.exe
 * `del` or POSIX `unlink` — they're blanked before matching. Everything
 * else still matches (`os.system('del x')`, `['shred', f]`).
 */
function _withoutCodeIdioms(code) {
    // `del` only before a Python name (`df[`, `self.x`, `a, b`) — not cmd's
    // `del notes\\a.md`; `.unlink(` only on a variable, not a quoted path
    // (review of 81283ca).
    return code
        .replace(/(^|[\n;:])([ \t]*)del[ \t]+(?=[A-Za-z_][\w.]*[ \t]*(?:$|[\[,;#)\r\n]))/gm, "$1$2")
        .replace(/\.unlink\s*\((?!\s*['"`])/g, ".(");
}
const SHELL_KEY_WORDS = new Set(["command", "cmd", "cmdline", "commandline", "argv", "shell"]);
function _commandArgs(input) {
    const { _argStrings, _isCommandKey } = require("./mcp-approvals");
    const walked = _argStrings(input, 64, 2048);
    if (walked.truncated)
        return null;
    const out = new Map();
    for (const [key, value] of walked.pairs) {
        if (!_isCommandKey(key))
            continue;
        // Review of f22cabc: every command-like argument is checked; whether it
        // is a SHELL key decides how strictly (see classify).
        const shell = _words(key).some((w) => SHELL_KEY_WORDS.has(w));
        const v = Array.isArray(value) ? value.join(" ") : String(value);
        if (!out.has(v) || shell)
            out.set(v, shell || !!out.get(v));
    }
    // Security review of 83183e6: spawn-style `{command: "cp", args: [a, b]}`
    // splits the verb from its paths, so the values are also checked together.
    if (out.size > 1) {
        const all = [...out];
        out.set(all.map(([c]) => c).join(" "), all.some(([, sh]) => sh));
    }
    return out.size > 256 ? null : [...out].map(([command, shell]) => ({ command, shell }));
}
function _tooLargeVerdict(tool, what) {
    return [{
            tool,
            matchedPattern: "arguments too large to inspect",
            category: "runs-arbitrary-code",
            title: _categoryTitle("runs-arbitrary-code"),
            userRisk: "This tool call is larger than Gryphon can check piece by piece, so it can't confirm it's safe.",
            technicalDetail: `Tool:            ${tool}\nArguments:       ${what}`,
        }];
}
/**
 * #36 item 2: shell commands that move, copy, link or create files are
 * checked by the paths they name — lexically, like the other command rules
 * (best-effort against a determined shell). A path that is a protected path
 * or a parent folder of one (moving `.obsidian/plugins` away, then putting
 * another folder there) yields a verdict.
 */
// Words that move, copy, link, create, extract or rewrite files.
const SHELL_FILE_VERBS = new Set([
    "mv", "cp", "ln", "rsync", "install", "ditto", "scp", "link", "dd", "touch", "chmod", "chown", "patch", "cpio", "pax",
    "gcp", "gmv", "gln", "ginstall", "unzip", "7z", "7za", "7zz", "7zr", "unrar", "rar",
    "move-item", "copy-item", "rename-item", "new-item", "set-content", "add-content", "out-file", "expand-archive",
    "mi", "cpi", "rni", "ni", "move", "copy", "ren", "rename", "xcopy", "robocopy", "mklink",
    "tee", "tee-object", "sc", "ac",
]);
// Verbs that only write with a particular flag or subcommand.
const TAR_VERBS = new Set(["tar", "bsdtar", "gtar"]);
const GIT_WRITE_SUBCOMMANDS = new Set(["clone", "checkout", "restore", "apply", "worktree", "mv"]);
const MAX_SHELL_TOKEN = 4096;
const MAX_SHELL_TOKENS = 20000;
const MAX_SHELL_TARGETS = 4096;
/**
 * Shell-style words (review of ec1f9d2: a plain regex split read
 * `.obsi"di"an/…` or `\.obsidian/…` differently from the shell). Unquoted
 * whitespace and ; & | ( ) < > end a word; quotes are removed and
 * adjacent parts joined. A word holding a backslash is read both ways —
 * POSIX (escape resolved; `\ ` joins) and Windows (backslash kept) — and
 * both are checked. `$` and backticks stay in the word (see below).
 */
function _shellWords(text) {
    const out = [];
    let esc = "", lit = "", has = false, quote = null;
    let litPieces = [];
    const add = (e, l = e) => { esc += e; lit += l; };
    const end = () => {
        if (has) {
            out.push(esc);
            for (const l of [...litPieces, lit])
                if (l && l !== esc)
                    out.push(l);
        }
        esc = "";
        lit = "";
        has = false;
        litPieces = [];
    };
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quote === "'") {
            if (c === "'")
                quote = null;
            else
                add(c);
            continue;
        }
        if (quote === '"') {
            if (c === '"') {
                quote = null;
                continue;
            }
            if (c === "\\" && i + 1 < text.length && /["\\$`]/.test(text[i + 1])) {
                add(text[i + 1], c + text[i + 1]);
                i++;
                continue;
            }
            add(c);
            continue;
        }
        if (c === "'" || c === '"') {
            quote = c;
            has = true;
            continue;
        }
        if (c === "\\" && i + 1 < text.length) {
            if (/\s/.test(text[i + 1])) {
                esc += text[i + 1];
                litPieces.push(lit + c);
                lit = "";
                i++;
                has = true;
                continue;
            }
            add(text[i + 1], c + text[i + 1]);
            i++;
            has = true;
            continue;
        }
        // Review of 0bfefd1: a `$(…)` / `${…}` stays part of its word
        // (`$(pwd)/.obsidian/…` must not leave `/.obsidian/…` behind).
        if (c === "$" && (text[i + 1] === "(" || text[i + 1] === "{")) {
            const open = text[i + 1], close = open === "(" ? ")" : "}";
            let depth = 0, j = i + 1;
            for (; j < text.length; j++) {
                if (text[j] === open)
                    depth++;
                else if (text[j] === close && --depth === 0)
                    break;
            }
            add(text.slice(i, j + 1));
            has = true;
            i = j;
            continue;
        }
        // Braces stay in the word (`.clau{de,}/…`): a `{ …; }` group is spaced.
        if (/[\s;&|()<>]/.test(c)) {
            end();
            continue;
        }
        add(c);
        has = true;
    }
    end();
    return out;
}
/**
 * Every place a word may name a path (fail closed, lexical): the word; the
 * value of `NAME=value`, `--opt=value`, `-Opt:value`; the rest after each
 * target-option letter bundled in a short option (`-rt.obsidian/…`,
 * `-xC.obsidian/…`); each path piece after a `$VAR` / `$(…)` / backtick
 * part (`$PWD/.obsidian/…`); the folder before a glob (`.obsidian/plug*`
 * names `.obsidian/`); and each word of a quoted multi-word argument (an
 * inner command), options included.
 */
function _pathCandidates(t, out) {
    const push = (x) => {
        if (!x)
            return;
        const c = x.replace(/^[`(]+|[`)]+$/g, "");
        out.push(c);
        // An argument in code (`shutil.move(".obsidian/plugins", …)`) keeps its comma.
        const trimmed = c.replace(/[,;:]+$/, "");
        if (trimmed && trimmed !== c)
            out.push(trimmed);
    };
    if (/[$`]/.test(t)) {
        const parts = t.split(/[\\/]/);
        // Past 256 pieces the word itself is reported as too large (and every
        // suffix would cost O(n²) — review of 9d63c9d).
        if (parts.length <= 256)
            for (let k = 1; k < parts.length; k++)
                push(parts.slice(k).join("/"));
    }
    if (/\s/.test(t)) {
        // An over-long quoted span (prose after a stray apostrophe) is not a
        // path; only its words are candidates (review of 0bfefd1).
        if (t.length <= MAX_SHELL_TOKEN)
            push(t);
        for (const w of _shellWords(_innerText(t)))
            _pathCandidates(w, out);
        return;
    }
    if (/^\/[A-Za-z]/.test(t) && t.length <= 8 && !t.includes("/", 1))
        return; // cmd switches (/y, /MIR)
    if (t.startsWith("-")) {
        const eq = t.search(/[=:]/);
        if (eq > 0)
            _pathCandidates(t.slice(eq + 1), out);
        else if (!t.startsWith("--"))
            for (let k = 1; k < t.length - 1; k++)
                if ("tCdo".includes(t[k]))
                    push(t.slice(k + 1));
        return;
    }
    push(t);
    const nameEq = /^[A-Za-z_]\w*=(.*)$/.exec(t);
    if (nameEq)
        _pathCandidates(nameEq[1], out);
    // A glob or brace pattern names at least the folder before it; one
    // `{a,b}` list is also expanded (review of 9d63c9d: `.clau{de,}/…`).
    const g = t.search(/[*?[{]/);
    if (g >= 0) {
        const dir = t.slice(0, g).replace(/[^\\/]*$/, "");
        if (dir)
            push(dir);
    }
    const br = /^([^{}]*)\{([^{}]*,[^{}]*)\}([^{}]*)$/.exec(t);
    // Every alternative (a cut-off list could hide the real one); the callers'
    // candidate caps bound the work.
    if (br)
        for (const alt of br[2].split(","))
            push(br[1] + alt + br[3]);
}
const _verbWord = (t) => (t.replace(/^[`$(]+/, "").split(/[\\/]/).pop() || "").toLowerCase().replace(/\.exe$/, "");
// Library calls that copy / move / link files (`shutil.copy(`, `os.rename(`,
// `FileUtils.cp`) — review of 0bfefd1: a python heredoc is a common agent idiom.
/** A word's inner text with `$(`, `${`, `)`, `}` and backticks blanked, so it re-splits into smaller words. */
const _innerText = (t) => t.replace(/\$[({]|[)}`]/g, " ");
// Library deletes too (security review of 81283ca): the unambiguous names
// (`.rm`, `.rmSync`, `.rmdir…`, `.unlink…`, `.rmtree`, `.removedirs`) on any
// object; `remove` / `delete` only on a filesystem object (`os.remove`), since
// `dirs.remove('.obsidian')` is the everyday vault-walk idiom (review of f2a229a).
const LIB_WRITE_RE = /(?:\.|::)(?:copy\w*|move|rename|replace|link|symlink|cp|mv|copytree|copyfile|copy2|write_text|write_bytes)\b|\b(?:os|shutil|fs|fsp|fse|promises|Deno|FileUtils|Files?|Directory)\]?(?:\.|::)(?:remove\w*|delete\w*)\b|(?:\.|::)(?:rm|rmSync|rmdir\w*|unlink\w*|rmtree|removedirs|WriteAll\w*|AppendAll\w*|writeFile\w*|appendFile\w*)\b/i;
/**
 * Targets of output redirections (`> f`, `>> f`, `2> f`, `&> f`, `>| f`,
 * `>& f`, `<> f`), or null when there are more than can be checked.
 * The word splitter drops `>`, so every `>` in the raw text — quoted or not,
 * whatever precedes it (`x=>f` is a redirect in a shell) — is read as one,
 * in a single linear pass; only the target is checked, so `cat > note.md
 * <<EOF` doesn't make every word of the note a path. Each target is read by
 * the shell word splitter, up to the next `>` (reviews of f2a229a/64446cb:
 * a regex prefix backtracked quadratically, skipped `=>`/`->`, and a capped
 * list dropped the rest silently).
 */
/** End of the shell word starting at `i` (quotes, escapes, `$(…)`), at most `stop`. */
function _wordEnd(text, i, stop) {
    let quote = null, depth = 0;
    for (; i < stop; i++) {
        const c = text[i];
        if (quote) {
            if (c === quote)
                quote = null;
            else if (quote === '"' && c === "\\")
                i++;
            continue;
        }
        if (c === "'" || c === '"') {
            quote = c;
            continue;
        }
        if (c === "\\") {
            i++;
            continue;
        }
        if (c === "$" && (text[i + 1] === "(" || text[i + 1] === "{")) {
            depth++;
            i++;
            continue;
        }
        if (depth && (c === ")" || c === "}")) {
            depth--;
            continue;
        }
        if (!depth && /[\s;&|()<>]/.test(c))
            return i;
    }
    return stop;
}
function _redirectTargets(command) {
    const ops = [];
    for (let i = 0; i < command.length; i++) {
        if (command[i] !== ">" || command[i + 1] === ">")
            continue;
        ops.push(i + 1);
        if (ops.length > MAX_SHELL_TARGETS)
            return null;
    }
    const out = [];
    for (let k = 0; k < ops.length; k++) {
        let i = ops[k];
        const stop = Math.min(command.length, i + MAX_SHELL_TOKEN + 64);
        // `>|` (bash) and `>!` (zsh) force an overwrite; so do `>&!` / `>&|`.
        if (command[i] === "|" || command[i] === "!")
            i++;
        while (i < stop && (command[i] === " " || command[i] === "\t"))
            i++;
        if (command[i] === "&") {
            i++;
            if (command[i] === "|" || command[i] === "!")
                i++;
            // `>&2`, `2>&1`, `>&-`: a file descriptor, not a file.
            let j = i;
            while (j < stop && /\d/.test(command[j]))
                j++;
            if ((j > i || command[j] === "-") && (j >= stop || /[\s;&|()<>]/.test(command[j]) || command[j] === "-"))
                continue;
            while (i < stop && (command[i] === " " || command[i] === "\t"))
                i++;
        }
        // The target is one shell word — quotes and escapes honoured, so a `>`
        // inside quotes doesn't end it (automatic review of 9d63c9d). Found by a
        // linear scan, then split (both spellings of a backslash word).
        const end = _wordEnd(command, i, stop);
        // A word still going at the cap is too long to read (quotes removed
        // could make the cut-off part look short): the caller's too-large verdict.
        if (end === stop && stop < command.length)
            return null;
        out.push(..._shellWords(command.slice(i, end)));
    }
    return out;
}
/**
 * Whether these words write files: a write verb, `tar` with an extract flag
 * (-x…, --ex…, --get), `sed -i`, or a writing `git` subcommand — also inside
 * a quoted inner command, checked the same way (automatic review of
 * 0bfefd1). One pass per level (a nested scan per `tar` was quadratic).
 */
function _writesFiles(toks, depth) {
    let tar = false, sed = false, git = false;
    for (const t of toks) {
        const w = _verbWord(t);
        if (SHELL_FILE_VERBS.has(w) || LIB_WRITE_RE.test(t))
            return true;
        if (TAR_VERBS.has(w))
            tar = true;
        else if (w === "sed" || w === "gsed")
            sed = true;
        else if (w === "git")
            git = true;
        else if (tar && (/^-?[A-Za-z]*x/.test(t) || /^--(ex|get?$|get)/.test(t)))
            return true;
        else if (sed && /^-[A-Za-z]*i|^--in-place/.test(t))
            return true;
        else if (git && GIT_WRITE_SUBCOMMANDS.has(w))
            return true;
        if (/\s/.test(t) && depth < 4 && _writesFiles(_shellWords(_innerText(t)), depth + 1))
            return true;
    }
    return false;
}
/**
 * #36 item 2: a shell command that moves, copies, links, creates, extracts
 * or rewrites files is checked by EVERY path it names — not parsed for
 * which operand is written, and heredoc text is not skipped (reviews of
 * f22cabc…5d58173: every narrower parse had cheap bypasses). A path that is
 * a protected path or a parent folder of one yields a verdict. Lexical,
 * like the other command rules: what a shell expands at run time ($VAR
 * values, glob matches, strings built by eval) can't be known here.
 */
/**
 * The CLI's own working directory for this call (security review of
 * 83183e6: Claude Code keeps a `cd` across Bash calls), when it is inside
 * the vault — relative paths in the command resolve from it.
 */
function _hookCwd(ctx) {
    const vaultRoot = ctx && typeof ctx.vaultRoot === "string" ? ctx.vaultRoot : null;
    const cwd = ctx && typeof ctx.cwd === "string" && ctx.cwd ? ctx.cwd : null;
    if (!vaultRoot || !cwd)
        return null;
    // Any folder: it only adds a base, and a path outside the vault matches
    // no protected path (security review of 81283ca: `..x` is in the vault).
    return path.resolve(vaultRoot, cwd);
}
function _shellPathVerdicts(tool, command, ctx, security, baseArgs = {}) {
    if (typeof command !== "string" || !command)
        return [];
    const vaultRoot = ctx && typeof ctx.vaultRoot === "string" ? ctx.vaultRoot : null;
    if (!vaultRoot)
        return [];
    const toks = _shellWords(command.replace(/\\\r?\n/g, " "));
    if (toks.length > MAX_SHELL_TOKENS)
        return _tooLargeVerdict(tool, "a command too long to inspect");
    const writes = _writesFiles(toks, 0);
    // A backslash-newline joins the words around it (`> .obsi\⏎dian/…`).
    const redirects = _redirectTargets(command.replace(/\\\r?\n/g, ""));
    if (redirects === null)
        return _tooLargeVerdict(tool, "a command with too many or too long redirections to inspect");
    if (redirects.some((t) => t.length > MAX_SHELL_TOKEN))
        return _tooLargeVerdict(tool, "a command naming a path too long to inspect");
    if (!writes && !redirects.length)
        return [];
    const targets = [];
    const distinct = new Set();
    for (const t of redirects) {
        _pathCandidates(t, targets);
        if (targets.length > 16 * MAX_SHELL_TARGETS)
            return _tooLargeVerdict(tool, "a command naming too many paths to inspect");
    }
    for (const t of targets)
        distinct.add(t);
    if (distinct.size > MAX_SHELL_TARGETS)
        return _tooLargeVerdict(tool, "a command naming too many paths to inspect");
    for (const t of writes ? toks : []) {
        if (t.length > MAX_SHELL_TOKEN && !/\s/.test(t))
            return _tooLargeVerdict(tool, "a command naming a path too long to inspect");
        const before = targets.length;
        _pathCandidates(t, targets);
        // Distinct candidates, kept incrementally (review of 5b4c8ab: rebuilding
        // a Set per word was quadratic); raw pushes are capped too.
        for (let k = before; k < targets.length; k++)
            distinct.add(targets[k]);
        if (distinct.size > MAX_SHELL_TARGETS || targets.length > 16 * MAX_SHELL_TARGETS)
            return _tooLargeVerdict(tool, "a command naming too many paths to inspect");
    }
    const { _resolveArgPaths, BASE_ARG_RE } = require("./mcp-approvals");
    const { shellCdDirs } = require("./tool-aliases");
    // Review of 83183e6: the call's own working folder (agy `Cwd`, gemini
    // `dir_path`/`directory`, an MCP `cwd`) is a base too, like a `cd`.
    const dirs = Object.entries(baseArgs || {}).filter(([k, v]) => typeof v === "string" && v && BASE_ARG_RE.test(k)).map(([, v]) => v);
    dirs.push(...shellCdDirs(command));
    const hookCwd = _hookCwd(ctx);
    if (hookCwd)
        dirs.unshift(hookCwd);
    const bases = [vaultRoot, ...dirs.slice(0, 8).flatMap((d) => _resolveArgPaths(d, [vaultRoot]))];
    if (targets.length * bases.length > 4 * MAX_SHELL_TARGETS || targets.some((t) => t.split(/[\\/]/).length > 256)) {
        return _tooLargeVerdict(tool, "a command naming paths too large or too many to inspect");
    }
    const out = [];
    for (const t of distinct) {
        for (const abs of _resolveArgPaths(t, bases)) {
            // An unresolvable token (most aren't paths) is skipped; the command
            // rules still apply to the command as a whole.
            let v;
            try {
                v = _classifyFilePath(tool, { file_path: abs }, ctx, security);
            }
            catch (_) {
                continue;
            }
            if (v)
                out.push({ ...v, technicalDetail: `${v.technicalDetail}\nCommand:         ${command}` });
        }
    }
    return out;
}
const UNGATED_TOOLS = new Set(["Read", "Glob", "Grep", "WebFetch", "WebSearch"]);
const MAX_UNKNOWN_TOOL_PATHS = 2048;
function _pathArgVerdicts(tool, input, ctx, security, keyFilter) {
    const { _argStrings, _resolveArgPaths, BASE_ARG_RE } = require("./mcp-approvals");
    const vaultRoot = ctx && typeof ctx.vaultRoot === "string" ? ctx.vaultRoot : null;
    if (!vaultRoot)
        return [];
    // Same walker and resolver as the store guard (dc9cc5d review): paths are
    // resolved from the vault AND from the call's own folder arguments, with
    // `~` and file: URLs expanded — never a narrower reading than the tool's.
    const walked = _argStrings(input, 64, MAX_UNKNOWN_TOOL_PATHS);
    const bases = new Set([vaultRoot]);
    for (const [key, value] of walked.pairs) {
        if (!BASE_ARG_RE.test(key))
            continue;
        for (const v of Array.isArray(value) ? value : [value])
            for (const b of _resolveArgPaths(v, [vaultRoot]))
                bases.add(b);
    }
    const tooLarge = () => [{
            tool,
            matchedPattern: "arguments too large to inspect",
            category: "runs-arbitrary-code",
            title: _categoryTitle("runs-arbitrary-code"),
            userRisk: "This tool call names more files than Gryphon can check one by one, so it can't confirm none of them is protected.",
            technicalDetail: `Tool:            ${tool}\nArguments:       too many paths to inspect`,
        }];
    // Only path / folder / command strings are counted, so ordinary data never
    // reaches this — a call that does is refused for approval, not waved through.
    if (walked.truncated)
        return tooLarge();
    const out = [];
    let checked = 0;
    for (const [key, value] of walked.pairs) {
        if (!_isPathKey(key) || (keyFilter && !keyFilter(key)))
            continue;
        for (const v of Array.isArray(value) ? value : [value]) {
            // Nothing is skipped: a value that LOOKS like a URL can still be a
            // relative path to the tool ('http://x/../../.obsidian/…' normalizes
            // into the vault), and a real URL never resolves to a protected file.
            if (typeof v !== "string" || !v)
                continue;
            for (const abs of _resolveArgPaths(v, [...bases])) {
                if (++checked > MAX_UNKNOWN_TOOL_PATHS * 4)
                    return tooLarge();
                const verdict = _classifyFilePath(tool, { file_path: abs }, ctx, security);
                if (verdict)
                    out.push({ ...verdict, technicalDetail: `${verdict.technicalDetail}\nArgument:        ${key}` });
            }
        }
    }
    return out;
}
/**
 * Issue #25 (Design rev 2): Gryphon runs a vault-defined MCP server only
 * when an approval in the user-profile store matches it. If the chat could
 * write that store, it could approve its own servers — so writes, edits
 * and shell commands aimed at it are protected: the modal (a user click),
 * even in YOLO, and denied outright under auto-deny.
 *
 * This is BEST-EFFORT against the model, not a guarantee. File tools are
 * gated on the resolved path of any path-like argument; shell commands
 * only lexically (globs, quoting inside a word, a staged `cd`, or
 * `python -c` assembling the path all get past it). A model with a shell
 * can already run commands directly, so that isn't an escalation past what
 * the shell grants. The property issue #25 guarantees is narrower: no
 * unapproved vault server starts automatically at spawn.
 *
 * The store lives OUTSIDE the vault, so it can't be a vault-relative
 * DEFAULT_PROTECTED_PATHS entry (those resolve inside the vault and are
 * user-toggleable). No per-pattern or master toggle switches this off.
 * With Protected Mode off the claude-code provider still emits the store's
 * permissions.deny rules, and codex / gemini / antigravity get the
 * store-guard hook (issue #30), which runs this same rule out of process.
 */
const APPROVALS_STORE_RISK = "This is where Gryphon records which of a vault's MCP servers you've approved to run. " +
    "A change here could approve a server on your behalf — and an MCP server is a program " +
    "that runs on your computer. Approve servers from Gryphon's own prompt instead.";
function _approvalsStoreVerdict(tool, what) {
    return {
        tool,
        matchedPattern: "gryphon MCP approval store",
        category: "modifies-gryphon",
        title: _categoryTitle("modifies-gryphon"),
        userRisk: APPROVALS_STORE_RISK,
        // Gryphon's own trust stores (MCP approvals, security settings) are
        // written only by Gryphon's UI on a user click — never by a tool call.
        // The gate refuses these in every mode (#29 review): no demotion when
        // Protected Mode is off, no YOLO/acceptEdits auto-accept, no modal.
        fixedInvariant: true,
        technicalDetail: `Tool:            ${tool}\n` +
            `${what}\n` +
            `Matched pattern: gryphon MCP approval store`,
    };
}
/**
 * R43-3: verdicts for every file a patch names. Relative paths resolve
 * from the vault root, from any dir argument the hook payload carries
 * (workdir/cwd/…), and from any `cd` in a shell command — a protected match
 * under ANY of those bases counts. Limit (R44 F5): Codex's exec_command hook
 * payload carries only the command, not the tool's own `workdir`, so a
 * relative patch run from another folder resolves from the vault root here;
 * the store files are still caught by name (and see #32 for lexical gaps).
 * A patch too large to scan is itself a verdict.
 */
const MAX_PATCH_RESOLUTIONS = 4000;
function _patchVerdicts(tool, input, ctx, security, baseArgs = input) {
    const info = patchTargetsInfo(input);
    if (info.truncated) {
        return [{
                tool,
                matchedPattern: "patch too large to inspect",
                category: "runs-arbitrary-code",
                title: _categoryTitle("runs-arbitrary-code"),
                userRisk: "This change touches more files than Gryphon can check one by one, so it can't confirm none of them is protected.",
                technicalDetail: `Tool:            ${tool}\nPatch:           more than the inspectable number of files`,
            }];
    }
    if (!info.targets.length)
        return [];
    const vaultRoot = ctx && typeof ctx.vaultRoot === "string" ? ctx.vaultRoot : null;
    if (!vaultRoot)
        return [];
    const bases = new Set([vaultRoot]);
    const extra = [];
    for (const [k, v] of Object.entries(baseArgs)) {
        if (typeof v === "string" && require("./mcp-approvals").BASE_ARG_RE.test(k))
            extra.push(v);
    }
    extra.push(...shellCdDirs(input.command));
    const hookCwd = _hookCwd(ctx);
    if (hookCwd)
        extra.push(hookCwd);
    for (const d of extra)
        bases.add(path.resolve(vaultRoot, d));
    // E7-1 / P8-1: bounded work — files × folders past the budget is itself
    // a verdict (approvable), never a long freeze or a silent allow.
    if (info.targets.length * bases.size > MAX_PATCH_RESOLUTIONS) {
        return [{
                tool,
                matchedPattern: "patch too large to inspect",
                category: "runs-arbitrary-code",
                title: _categoryTitle("runs-arbitrary-code"),
                userRisk: "This change touches more files than Gryphon can check one by one, so it can't confirm none of them is protected.",
                technicalDetail: `Tool:            ${tool}\nPatch:           ${info.targets.length} files × ${bases.size} folders`,
            }];
    }
    const out = [];
    for (const target of info.targets) {
        for (const base of bases) {
            const abs = path.resolve(base, target);
            const v = _classifyFilePath(tool, { ...input, file_path: abs }, ctx, security);
            if (v) {
                out.push({ ...v, technicalDetail: `${v.technicalDetail}\nPatched file:    ${target}` });
                break;
            }
        }
    }
    return out;
}
const SEVERITY_ORDER = [
    "modifies-gryphon", "escalates-privileges", "persistent-execution", "runs-arbitrary-code",
    "accesses-system", "network-exec", "destructive-operation", "modifies-editor",
    "network-fetch", "package-install", "user-custom",
];
/** The most severe verdict; the others are listed in its detail (R43-3 consent). */
function _mostSevere(verdicts) {
    const list = verdicts.filter(Boolean);
    if (!list.length)
        return null;
    const rank = (v) => (v.fixedInvariant ? -1 : (SEVERITY_ORDER.indexOf(v.category) + 1 || SEVERITY_ORDER.length + 1));
    const sorted = [...list].sort((a, b) => rank(a) - rank(b));
    const [top, ...rest] = sorted;
    if (!rest.length)
        return top;
    const also = rest.map((v) => `${v.title} (${v.matchedPattern})`).join("; ");
    return { ...top, technicalDetail: `${top.technicalDetail}\nAlso matched:    ${also}` };
}
/** realpath of the deepest existing ancestor + the missing tail. */
function _realishPath(p) {
    let cur = p;
    const tail = [];
    for (let i = 0; i < 64; i++) {
        try {
            return path.join(fs.realpathSync(cur), ...tail.reverse());
        }
        catch (_) { /* walk up */ }
        const parent = path.dirname(cur);
        if (parent === cur)
            break;
        tail.push(path.basename(cur));
        cur = parent;
    }
    return p;
}
function _classifyFilePath(tool, input, ctx, security) {
    const vaultRoot = ctx && ctx.vaultRoot;
    if (!vaultRoot)
        return null;
    const filePath = input.file_path;
    if (typeof filePath !== "string" || !filePath)
        return null;
    // Review of 7075f35 (F4): resolving a huge path walks it slowly; refuse it
    // for approval instead of freezing the window.
    if (filePath.length > MAX_SHELL_TOKEN || filePath.split(/[\\/]/).length > 256)
        return _tooLargeVerdict(tool, "a path too long to inspect")[0];
    let resolved;
    try {
        resolved = resolveVaultPath(filePath, vaultRoot);
    }
    catch (e) {
        // PathOutsideVaultError is legitimate — the SDK tool's own
        // resolveVaultPath rejects these, so the file never reaches a
        // write/edit. Not our domain; return null so gate() routes via
        // the caller's permission mode. ANY OTHER error (EIO from a
        // flaky mount, EACCES reading a parent dir, symlink loops)
        // indicates we can't evaluate the path — fail closed by
        // re-throwing so _handleClassifyRequest's outer catch returns
        // `{decision:"deny"}` with a visible reason, rather than
        // silently allowing an unclassifiable path.
        if (!(e instanceof PathOutsideVaultError))
            throw e;
        // R43-6: another NAME for a place inside the vault (symlinked vault
        // folder, macOS firmlink, Windows UNC/8.3 spelling) is still inside it.
        // R2-1: try `..`-collapsed and on-disk spellings too.
        let rebased = null;
        for (const spelling of [String(filePath), path.resolve(String(filePath)), _realishPath(String(filePath))]) {
            rebased = rebaseOntoRoot(spelling, String(vaultRoot));
            if (rebased)
                break;
        }
        if (!rebased)
            return null;
        try {
            resolved = resolveVaultPath(rebased, vaultRoot);
        }
        catch (e2) {
            if (e2 instanceof PathOutsideVaultError)
                return null;
            throw e2;
        }
    }
    const rawRel = path.relative(String(vaultRoot), String(resolved)).replace(/\\/g, "/");
    // Same normalization as command-path matching: NFKC + zero-width strip.
    // Closes naïve Unicode obfuscation on file paths if CC ever emits one.
    const rel = _normalizeForMatch(rawRel);
    const defs = _activePatternDefs(DEFAULT_PROTECTED_PATHS, security.protectedPathsDisabled, security.protectedPathsCustom);
    for (const def of defs) {
        if (matchProtectedPath(rel, [def.pattern])) {
            return {
                tool,
                matchedPattern: def.pattern,
                category: def.category || "user-custom",
                title: _categoryTitle(def.category),
                userRisk: def.userRisk || def.explanation ||
                    `Target path matches the protected pattern "${def.pattern}".`,
                technicalDetail: `Tool:            ${tool}\n` +
                    `Target path:     ${rawRel}\n` +
                    `Matched pattern: ${def.pattern}`,
            };
        }
    }
    // #36 item 2: a PARENT folder of a protected path counts too — moving or
    // replacing `.obsidian/plugins` takes `.obsidian/plugins/gryphon/` with it.
    // The vault root itself is excluded (every pattern is under it).
    const relDir = rel.replace(/\/+$/, "").toLowerCase();
    for (const def of defs) {
        // Same normalisation as matchProtectedPath (review of 7075f35, F5).
        const pat = String(def.pattern || "").replace(/\\/g, "/").trim().toLowerCase();
        if (!pat || pat.startsWith("#"))
            continue;
        if (relDir && pat.startsWith(`${relDir}/`) && pat.length > relDir.length + 1) {
            return {
                tool,
                matchedPattern: def.pattern,
                category: def.category || "user-custom",
                title: _categoryTitle(def.category),
                userRisk: `This touches a folder that contains a protected path (${def.pattern}). Moving, replacing or deleting the folder affects what's inside it.`,
                technicalDetail: `Tool:            ${tool}\n` +
                    `Target path:     ${rawRel}\n` +
                    `Contains:        ${def.pattern}`,
            };
        }
    }
    return null;
}
// Command / path normalisation (NFKC + zero-width strip) is shared with the
// store rule — see mcp-approvals.normalizeForMatch. Cyrillic homoglyphs
// (`рm`) use distinct codepoints — a confusables fold table could close
// that gap, but the threat profile doesn't justify the table's bundle-size
// cost. See docs/adr/0001.
const _normalizeForMatch = normalizeForMatch;
function _classifyCommand(tool, input, ctx, security, onlyCategories = null) {
    const rawCommand = input && typeof input.command === "string" ? input.command : "";
    if (!rawCommand)
        return null;
    const command = _normalizeForMatch(rawCommand);
    const defs = _activePatternDefs(DEFAULT_PROTECTED_COMMANDS, security.protectedCommandsDisabled, security.protectedCommandsCustom);
    const muteInstall = security.blockPackageInstall === false;
    const activeDefs = (muteInstall ? defs.filter((d) => d.category !== "package-install") : defs)
        .filter((d) => !onlyCategories || !d.category || d.category === "user-custom" || onlyCategories.has(d.category));
    for (const def of activeDefs) {
        let re;
        try {
            re = new RegExp(def.pattern, "i");
        }
        catch (compileErr) {
            // Invalid custom regex — we can't just silently skip, because
            // the user added this pattern expecting it to enforce. Surface
            // via a one-time-per-pattern warning so they can fix it in
            // Settings. Classifier still skips this rule (can't match with
            // an un-compilable regex) but every OTHER rule still runs.
            _warnInvalidPatternOnce(def.pattern, compileErr, ctx && ctx.hostAdapter);
            continue;
        }
        if (re.test(command)) {
            return {
                tool,
                matchedPattern: def.pattern,
                category: def.category || "user-custom",
                title: _categoryTitle(def.category),
                userRisk: def.userRisk || def.explanation ||
                    `Command matches the protected pattern "${def.pattern}".`,
                technicalDetail: `Tool:            ${tool}\n` +
                    `Command:         ${rawCommand}\n` +
                    `Matched pattern: ${def.pattern}`,
            };
        }
    }
    return null;
}
/**
 * Decide whether to allow a tool call.
 *
 * If classification is non-null, we fire the protected-operation modal
 * (it overrides Safe/YOLO). Otherwise we fall through to the standard
 * permission-gate flow for the caller's mode policy.
 *
 * @param {object|null} classification — classify() result
 * @param {object} opts
 *   ctx, action, target, detail — same as checkPermission
 *   kind — "fileEdit" or "exec"
 *   cacheable — same as checkPermission (only applied when unprotected)
 * @returns {Promise<{allow, reason}>}
 */
async function gate(classification, opts) {
    const { ctx, action, target, detail, kind = "fileEdit", cacheable = true, } = opts || {};
    if (classification) {
        const protectedKind = kind === "exec" ? "protected-exec" : "protected";
        const combinedDetail = classification.technicalDetail
            + (detail ? `\n\n--- details ---\n${detail}` : "");
        return await checkPermission({
            ctx,
            action,
            target,
            detail: combinedDetail,
            kind: protectedKind,
            cacheable: false,
            warning: classification.userRisk,
            category: classification.category,
            categoryTitle: classification.title,
            fixedInvariant: "fixedInvariant" in classification && classification.fixedInvariant === true,
        });
    }
    return await checkPermission({
        ctx,
        action,
        target,
        detail,
        kind,
        cacheable,
    });
}
/**
 * Public helper: normalize a provider-specific tool name to the
 * Claude-Code vocabulary. Returns the input unchanged when no alias
 * is registered. Exposed because `_handleClassifyRequest` in
 * plugin.js needs to make the same isMutating / kind decisions
 * `classify()` makes internally — without it, the Bash/PowerShell
 * branches there fail to fire for Gemini's `run_shell_command`,
 * the modal-construction picks wrong kind, and the user sees a
 * generic deny instead of the category-specific reason
 * ("(destructive operation)"). User report 2026-05-03.
 */
function normalizeToolName(tool) {
    return TOOL_ALIASES[tool] || tool;
}
module.exports = {
    classify,
    gate,
    normalizeToolName,
    // Exported for unit tests only:
    _activePatternDefs,
    _categoryTitle,
    TOOL_ALIASES,
};
