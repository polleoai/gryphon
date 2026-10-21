"use strict";
/**
 * Grep tool — content search across files using a regex pattern.
 *
 * Mirrors Claude Code's Grep but implemented in pure Node (no ripgrep
 * dependency). For very large vaults this will be slower than rg —
 * acceptable tradeoff for Anthropic API mode where we need pure-JS portability.
 *
 * Output modes:
 *   "content"            — matching lines with line numbers (default)
 *   "files_with_matches" — paths only, one per line
 *   "count"              — match count per file
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.SCHEMA = void 0;
exports.execute = execute;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const gryphon_protect_1 = require("@polleoai/gryphon-protect");
const globModule = __importStar(require("./glob"));
const SCHEMA = {
    name: "Grep",
    description: "Search file contents using a regex pattern. Returns matching lines, " +
        "file paths, or match counts depending on output_mode. Filter the file " +
        "set with the path or glob parameters.",
    input_schema: {
        type: "object",
        properties: {
            pattern: {
                type: "string",
                description: "The regular expression pattern to search for.",
            },
            path: {
                type: "string",
                description: "File or directory to search in. Defaults to vault root.",
            },
            glob: {
                type: "string",
                description: "Filter files by glob pattern (e.g. '*.md').",
            },
            output_mode: {
                type: "string",
                enum: ["content", "files_with_matches", "count"],
                description: "Output format. Defaults to 'files_with_matches'.",
            },
            "-i": { type: "boolean", description: "Case-insensitive search." },
            "-n": { type: "boolean", description: "Show line numbers (content mode)." },
            head_limit: {
                type: "integer",
                description: "Limit output to first N entries. Defaults to 250.",
            },
        },
        required: ["pattern"],
    },
};
exports.SCHEMA = SCHEMA;
const DEFAULT_LIMIT = 250;
const MAX_FILES_SCANNED = 5000;
const MAX_FILE_SIZE = 1024 * 1024; // skip files > 1MB
async function execute(input, ctx) {
    const pattern = input.pattern;
    if (!pattern)
        return _error("Missing required parameter: pattern");
    let regex;
    try {
        const flags = input["-i"] ? "i" : "";
        regex = new RegExp(pattern, flags);
    }
    catch (e) {
        return _error(`Invalid regex pattern: ${e.message}`);
    }
    let searchRoot;
    try {
        searchRoot = input.path
            ? (0, gryphon_protect_1.resolveVaultPath)(input.path, ctx.vaultRoot)
            : ctx.vaultRoot;
    }
    catch (e) {
        if (e instanceof gryphon_protect_1.PathOutsideVaultError) {
            return _error(`Search path is outside the vault: ${input.path}`);
        }
        return _error(String(e.message || e));
    }
    const outputMode = input.output_mode || "files_with_matches";
    const showLineNumbers = input["-n"] !== false;
    const limit = Math.min(10000, parseInt(String(input.head_limit || DEFAULT_LIMIT), 10));
    let globRegex = null;
    if (input.glob) {
        try {
            globRegex = globModule._globToRegex
                ? globModule._globToRegex(input.glob)
                : _simpleGlobToRegex(input.glob);
        }
        catch {
            globRegex = _simpleGlobToRegex(input.glob);
        }
    }
    const results = []; // { path, line, lineNo, count }
    const fileMatchCounts = new Map(); // path → count
    let filesScanned = 0;
    function scanFile(filePath) {
        if (filesScanned >= MAX_FILES_SCANNED)
            return;
        filesScanned++;
        let stat;
        try {
            stat = fs.statSync(filePath);
        }
        catch {
            return;
        }
        if (stat.size > MAX_FILE_SIZE)
            return;
        let content;
        try {
            content = fs.readFileSync(filePath, "utf8");
        }
        catch {
            return;
        }
        const lines = content.split("\n");
        let count = 0;
        for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
                count++;
                if (outputMode === "content" && results.length < limit) {
                    results.push({ path: filePath, line: lines[i], lineNo: i + 1 });
                }
            }
        }
        if (count > 0)
            fileMatchCounts.set(filePath, count);
    }
    function walk(dir) {
        if (filesScanned >= MAX_FILES_SCANNED)
            return;
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (entry.isDirectory() && _isIgnoredDir(entry.name))
                continue;
            const full = path.join(dir, entry.name);
            if (entry.isFile()) {
                if (globRegex) {
                    const rel = path.relative(ctx.vaultRoot, full);
                    if (!globRegex.test(rel) && !globRegex.test(entry.name))
                        continue;
                }
                scanFile(full);
            }
            else if (entry.isDirectory()) {
                walk(full);
            }
        }
    }
    // If searchRoot is a file, just scan it. Otherwise walk.
    let rootStat;
    try {
        rootStat = fs.statSync(searchRoot);
    }
    catch {
        return _error(`Path not found: ${input.path || searchRoot}`);
    }
    if (rootStat.isFile()) {
        scanFile(searchRoot);
    }
    else {
        walk(searchRoot);
    }
    if (outputMode === "files_with_matches") {
        const paths = [...fileMatchCounts.keys()].slice(0, limit);
        return _ok(paths.length === 0
            ? "(no matches)"
            : paths.join("\n") + (fileMatchCounts.size > limit
                ? `\n\n[showing ${limit} of ${fileMatchCounts.size} files with matches]`
                : ""));
    }
    if (outputMode === "count") {
        const lines = [...fileMatchCounts.entries()]
            .slice(0, limit)
            .map(([p, c]) => `${p}: ${c}`);
        return _ok(lines.length === 0 ? "(no matches)" : lines.join("\n"));
    }
    // content mode
    if (results.length === 0)
        return _ok("(no matches)");
    const out = results.map((r) => showLineNumbers
        ? `${r.path}:${r.lineNo}: ${r.line}`
        : `${r.path}: ${r.line}`);
    return _ok(out.join("\n"));
}
// `.obsidian` is Obsidian's default config-folder name; held as a const (not an
// inline literal) because this is a directory skip-list entry, not Vault path
// navigation, and this tool runs headless where Vault#configDir is unavailable.
const CONFIG_DIR = `.obsidian`;
const IGNORED_DIRS = new Set([
    ".git", CONFIG_DIR, "node_modules", ".venv", "venv",
    "__pycache__", ".pytest_cache", "dist", "build", ".next",
    ".kb-trash",
]);
function _isIgnoredDir(name) {
    return IGNORED_DIRS.has(name) || name.startsWith(".cache");
}
// Minimal fallback glob → regex (used if glob.js' helper isn't exported).
function _simpleGlobToRegex(glob) {
    const escaped = glob
        .replace(/[.+()|^$\\]/g, "\\$&")
        .replace(/\*\*/g, "__DOUBLESTAR__")
        .replace(/\*/g, "[^/]*")
        .replace(/__DOUBLESTAR__/g, ".*")
        .replace(/\?/g, "[^/]");
    return new RegExp("^" + escaped + "$");
}
function _ok(text) {
    return { content: [{ type: "text", text }], isError: false };
}
function _error(text) {
    return { content: [{ type: "text", text: `Error: ${text}` }], isError: true };
}
