"use strict";
/**
 * Consumer-owned memory carrier (issue #27, Part A).
 *
 * Scoped launches run with `--setting-sources=` (no settings files), and the
 * `project` source is also what makes Claude Code load the vault's
 * CLAUDE.md. A consumer that depends on its CLAUDE.md (Athena's immutable
 * security rules live there) names it in `claudeCodeScope.memoryFiles`;
 * Gryphon assembles one file and passes it as `--append-system-prompt-file`.
 *
 * `--append-system-prompt-file` doesn't expand `@path` imports (live-probed,
 * claude 2.1.292), so this does — the way Claude Code does natively:
 *   - relative to the importing file; `~` is NOT expanded
 *   - max depth 5; each file included once (cycle guard)
 *   - `@` inside fenced or inline code is not an import
 *   - a path that doesn't name an existing file is plain text, not an import
 * Containment: an import's realpath must stay under the directory of the
 * top-level memory file that started the chain; one that escapes is skipped
 * with a warning. Text concatenation only — nothing is executed.
 *
 * Pure apart from reading the named files: returns the text and the
 * problems; the provider writes the temp file and surfaces the problems.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.LARGE_MEMORY_CHARS = exports.MAX_IMPORT_DEPTH = void 0;
exports.buildMemoryAppendix = buildMemoryAppendix;
exports.writeMemoryFile = writeMemoryFile;
exports.findImports = findImports;
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const MAX_IMPORT_DEPTH = 5;
exports.MAX_IMPORT_DEPTH = MAX_IMPORT_DEPTH;
/**
 * Per-file ceiling. A vault CLAUDE.md can @-import any file under its own
 * directory — including a multi-hundred-MB attachment. Skip, don't truncate:
 * half a rules file is worse than a visible "not loaded".
 */
const MAX_MEMORY_FILE_BYTES = 1024 * 1024;
/**
 * An import that names a network or drive path is never a memory import.
 * Checked BEFORE any fs call: on Windows, merely realpath/stat-ing
 * `\\host\share\x` (or `//host/share/x`) opens an SMB/WebDAV connection
 * and hands the host the user's NTLM credentials — zero-click, every spawn,
 * from vault content. Containment rejected the path, but only after the
 * access had already happened.
 */
const NETWORK_OR_DRIVE_REF = /^(?:\\\\|\/\/|[A-Za-z]:)/;
/** Claude Code's own "large memory file" threshold. Warn, never truncate. */
const LARGE_MEMORY_CHARS = 40000;
exports.LARGE_MEMORY_CHARS = LARGE_MEMORY_CHARS;
function isUnder(child, root) {
    const rel = path.relative(root, child);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}
/** `@path` tokens outside fenced and inline code, in document order. */
function findImports(text) {
    const out = [];
    let fence = null;
    for (const line of text.split(/\r?\n/)) {
        const m = /^\s*(`{3,}|~{3,})/.exec(line);
        if (m) {
            if (fence === null)
                fence = m[1][0];
            else if (m[1][0] === fence)
                fence = null;
            continue;
        }
        if (fence !== null)
            continue;
        const bare = line.replace(/`[^`]*`/g, " ");
        const re = /(?:^|\s)@([^\s]+)/g;
        let t;
        while ((t = re.exec(bare)) !== null)
            out.push(t[1]);
    }
    return out;
}
function buildMemoryAppendix(files) {
    const parts = [];
    const missing = [];
    const warnings = [];
    const seen = new Set();
    const include = (real, root, depth) => {
        if (seen.has(real))
            return;
        seen.add(real);
        let body;
        try {
            const size = fs.statSync(real).size;
            if (size > MAX_MEMORY_FILE_BYTES) {
                warnings.push(`skipped memory file ${real}: ${size} bytes is over the ${MAX_MEMORY_FILE_BYTES}-byte limit`);
                return;
            }
            body = fs.readFileSync(real, "utf8");
        }
        catch (e) {
            warnings.push(`couldn't read memory import ${real} (${(e && e.message) || e})`);
            return;
        }
        parts.push(`<!-- memory: ${path.relative(root, real).split(path.sep).join("/")} -->\n${body}`);
        if (depth >= MAX_IMPORT_DEPTH)
            return;
        for (const ref of findImports(body)) {
            // Lexical gates first — no fs call may touch a path outside `root`.
            if (NETWORK_OR_DRIVE_REF.test(ref)) {
                warnings.push(`skipped memory import @${ref} in ${path.basename(real)}: network/drive paths are never imported`);
                continue;
            }
            const target = path.resolve(path.dirname(real), ref);
            if (!isUnder(target, root)) {
                warnings.push(`skipped memory import @${ref} in ${path.basename(real)}: it resolves outside ${root}`);
                continue;
            }
            let targetReal;
            try {
                targetReal = fs.realpathSync(target);
                if (!fs.statSync(targetReal).isFile())
                    continue;
            }
            catch (_) {
                continue; // not a file → an ordinary "@word", not an import
            }
            if (!isUnder(targetReal, root)) {
                warnings.push(`skipped memory import @${ref} in ${path.basename(real)}: it resolves outside ${root}`);
                continue;
            }
            include(targetReal, root, depth + 1);
        }
    };
    for (const f of files) {
        if (!path.isAbsolute(f)) {
            // Relative to what? Never guess (it could resolve into the vault).
            missing.push(f);
            warnings.push(`memory file ${f} is not an absolute path`);
            continue;
        }
        let real;
        let root;
        try {
            // Root = the directory the consumer NAMED, resolved — not the
            // directory of wherever a symlinked file points. A vault can ship
            // CLAUDE.md as a symlink (git keeps them); following it would move
            // the containment root out of the vault.
            root = fs.realpathSync(path.dirname(f));
            real = fs.realpathSync(f);
            if (!fs.statSync(real).isFile())
                throw new Error("not a file");
        }
        catch (_) {
            missing.push(f);
            continue;
        }
        if (!isUnder(real, root)) {
            missing.push(f);
            warnings.push(`memory file ${f} resolves outside ${root} (symlink); not loaded`);
            continue;
        }
        if (fs.statSync(real).size > MAX_MEMORY_FILE_BYTES) {
            missing.push(f); // its rules are NOT in effect — surface it like a missing file
            warnings.push(`memory file ${f} is over the ${MAX_MEMORY_FILE_BYTES}-byte limit; not loaded`);
            continue;
        }
        include(real, root, 0);
    }
    const text = parts.join("\n\n");
    if (text.length > LARGE_MEMORY_CHARS) {
        warnings.push(`memory files total ${text.length} chars (over ${LARGE_MEMORY_CHARS}); large memory costs context on every turn`);
    }
    return { text, missing, warnings };
}
/**
 * Write the assembled memory for `--append-system-prompt-file`. Same temp
 * family and flags as the --settings file (`wx` refuses a pre-planted
 * file/symlink, 0600 owner-only); the onload orphan sweep reaps crash
 * leftovers. The provider unlinks it when the CLI closes.
 */
function writeMemoryFile(text) {
    const rand = crypto.randomBytes(4).toString("hex");
    const full = path.join(os.tmpdir(), `gryphon-cc-memory-${process.pid}-${Date.now()}-${rand}.md`);
    fs.writeFileSync(full, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return full;
}
