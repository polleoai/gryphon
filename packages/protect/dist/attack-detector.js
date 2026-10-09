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
        return _classifyFilePath(canonical, input, ctx, security);
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
        if (security.protectedCommandsEnabled !== false) {
            const cmd = _classifyCommand(canonical, input, ctx, security);
            if (cmd)
                verdicts.unshift(cmd);
        }
        return _mostSevere(verdicts);
    }
    // Read / Glob / Grep / WebFetch / WebSearch are not currently gated —
    // their outputs carry the threat, not their inputs. Returning null
    // here keeps the detector a no-op for them (permission-gate still
    // handles its existing policy for tools that call it).
    return null;
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
        if (typeof v === "string" && /cwd|dir(?:ectory)?s?$|folders?$|^(?:root|base)$/i.test(k))
            extra.push(v);
    }
    extra.push(...shellCdDirs(input.command));
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
    return null;
}
// Command / path normalisation (NFKC + zero-width strip) is shared with the
// store rule — see mcp-approvals.normalizeForMatch. Cyrillic homoglyphs
// (`рm`) use distinct codepoints — a confusables fold table could close
// that gap, but the threat profile doesn't justify the table's bundle-size
// cost. See docs/adr/0001.
const _normalizeForMatch = normalizeForMatch;
function _classifyCommand(tool, input, ctx, security) {
    const rawCommand = input && typeof input.command === "string" ? input.command : "";
    if (!rawCommand)
        return null;
    const command = _normalizeForMatch(rawCommand);
    const defs = _activePatternDefs(DEFAULT_PROTECTED_COMMANDS, security.protectedCommandsDisabled, security.protectedCommandsCustom);
    const muteInstall = security.blockPackageInstall === false;
    const activeDefs = muteInstall ? defs.filter((d) => d.category !== "package-install") : defs;
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
