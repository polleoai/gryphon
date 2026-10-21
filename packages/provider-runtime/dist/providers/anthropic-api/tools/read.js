"use strict";
/**
 * Read tool — returns file contents with optional line offset/limit.
 *
 * Schema mirrors Claude Code's built-in Read tool so model behavior is
 * consistent across CLI and Anthropic API modes. Output format also mirrors CC's
 * (line-numbered with `cat -n` style) — the model has been trained on
 * this format, so reproducing it gives better tool-use behavior.
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
const SCHEMA = {
    name: "Read",
    description: "Reads a file from the local filesystem. Returns content with line numbers " +
        "in the format '<line_no>\\t<line_text>'. Use the offset and limit parameters " +
        "to read large files in chunks.",
    input_schema: {
        type: "object",
        properties: {
            file_path: {
                type: "string",
                description: "Absolute path to the file, or path relative to the vault root.",
            },
            offset: {
                type: "integer",
                description: "Line number to start reading from (1-based). Optional.",
            },
            limit: {
                type: "integer",
                description: "Maximum number of lines to read. Defaults to 2000.",
            },
        },
        required: ["file_path"],
    },
};
exports.SCHEMA = SCHEMA;
const DEFAULT_LIMIT = 2000;
const MAX_LINE_LENGTH = 2000; // truncate very long lines
// Default upper bound when no plugin setting is available. Obsidian's
// Electron renderer has far less heap than Node's 2 GB default — a
// 500 MB log file OOMs the app before any error surfaces. 10 MB is
// generous for text content; the user can override via Settings →
// Gryphon → Max file size (MB). See the Edit tool for the same cap.
const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024;
function _maxFileSize(ctx) {
    const mb = ctx && ctx.plugin && ctx.plugin.settings &&
        Number(ctx.plugin.settings.maxReadFileSizeMb);
    if (typeof mb === "number" && Number.isFinite(mb) && mb > 0)
        return Math.floor(mb * 1024 * 1024);
    return DEFAULT_MAX_FILE_SIZE;
}
async function execute(input, ctx) {
    const filePath = input.file_path;
    const offset = Math.max(1, parseInt(String(input.offset || 1), 10));
    const limit = Math.min(10000, parseInt(String(input.limit || DEFAULT_LIMIT), 10));
    let resolved;
    try {
        resolved = (0, gryphon_protect_1.resolveVaultPath)(filePath, ctx.vaultRoot);
    }
    catch (e) {
        if (e instanceof gryphon_protect_1.PathOutsideVaultError) {
            return _error(`Path is outside the vault: ${filePath}. SDK-mode tools can only access files within the vault.`);
        }
        return _error(String(e.message || e));
    }
    let stat;
    try {
        stat = fs.statSync(resolved);
    }
    catch {
        return _error(`File not found: ${filePath}`);
    }
    if (stat.isDirectory()) {
        return _error(`Path is a directory, not a file: ${filePath}. Use Glob to list directory contents.`);
    }
    const maxSize = _maxFileSize(ctx);
    if (stat.size > maxSize) {
        const mb = (stat.size / 1024 / 1024).toFixed(1);
        const limitMb = maxSize / 1024 / 1024;
        return _error(`File too large: ${filePath} is ${mb} MB (limit ${limitMb} MB). ` +
            `Use the offset and limit parameters to page through specific line ranges, ` +
            `or Grep to search within the file without loading the whole thing.`);
    }
    // Detect binary by extension — for Anthropic API mode, we don't try to render
    // images/PDFs (CC handles that natively; we'd need separate base64
    // encoding logic). Phase 6 polish item if it matters.
    const ext = path.extname(resolved).toLowerCase();
    const binaryExts = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".mp3", ".mp4", ".zip", ".bin"]);
    if (binaryExts.has(ext)) {
        return _error(`Cannot read binary file (${ext}) in Anthropic API mode. Claude Code mode supports image and PDF reading natively.`);
    }
    let content;
    try {
        content = fs.readFileSync(resolved, "utf8");
    }
    catch (e) {
        return _error(`Failed to read file: ${e.message}`);
    }
    if (content === "") {
        return _ok("(file is empty)");
    }
    const lines = content.split("\n");
    const startIdx = offset - 1; // convert 1-based offset to 0-based index
    const endIdx = Math.min(lines.length, startIdx + limit);
    const slice = lines.slice(startIdx, endIdx);
    const numbered = slice.map((line, i) => {
        const lineNo = startIdx + i + 1;
        const truncated = line.length > MAX_LINE_LENGTH
            ? line.substring(0, MAX_LINE_LENGTH) + ` ... [truncated, line was ${line.length} chars]`
            : line;
        return `${lineNo}\t${truncated}`;
    });
    let footer = "";
    if (endIdx < lines.length) {
        footer = `\n\n[file has ${lines.length} lines total; showed ${startIdx + 1}-${endIdx}]`;
    }
    return _ok(numbered.join("\n") + footer);
}
function _ok(text) {
    return { content: [{ type: "text", text }], isError: false };
}
function _error(text) {
    return { content: [{ type: "text", text: `Error: ${text}` }], isError: true };
}
