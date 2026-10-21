"use strict";
/**
 * F3 (v1.7.0) — auto-memory audit and archive helpers.
 *
 * Claude Code's auto-memory system loads everything under
 * `~/.claude/projects/<escaped-vault-path>/memory/MEMORY.md` (the index
 * file) plus on-demand pulls from sibling .md files in the same dir.
 * Active power users accumulate hundreds of memory files over months,
 * and the index frequently overflows CC's 24KB cap — the tail gets
 * silently truncated, which makes some prior context invisible to the
 * model.
 *
 * This module is the pure-logic substrate for the `/memory` modal in
 * chat-view: it finds the memory dir, lists files with `{name, size,
 * mtimeMs, ageDays, isCandidate}`, archives selected files to a
 * sibling `memory-archive/` directory (which CC does NOT scan), and
 * comments out the archived entries in `MEMORY.md` so the index stays
 * valid markdown but its dead references stop loading.
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
exports.DEFAULT_ARCHIVE_AGE_DAYS = exports.ARCHIVE_DIRNAME = exports.MEMORY_INDEX_NAME = void 0;
exports.findMemoryDir = findMemoryDir;
exports.listMemoryFiles = listMemoryFiles;
exports.classifyMemoryFiles = classifyMemoryFiles;
exports.archiveMemoryFiles = archiveMemoryFiles;
exports.unarchiveMemoryFiles = unarchiveMemoryFiles;
exports.updateMemoryIndex = updateMemoryIndex;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const context_budget_1 = require("./context-budget");
const MEMORY_INDEX_NAME = "MEMORY.md";
exports.MEMORY_INDEX_NAME = MEMORY_INDEX_NAME;
const ARCHIVE_DIRNAME = "memory-archive";
exports.ARCHIVE_DIRNAME = ARCHIVE_DIRNAME;
const DEFAULT_ARCHIVE_AGE_DAYS = 90;
exports.DEFAULT_ARCHIVE_AGE_DAYS = DEFAULT_ARCHIVE_AGE_DAYS;
function findMemoryDir({ vaultPath, homeDir }) {
    if (typeof vaultPath !== "string" || !vaultPath)
        return null;
    if (typeof homeDir !== "string" || !homeDir)
        return null;
    const escaped = (0, context_budget_1.escapeVaultPath)(vaultPath);
    const dir = path.join(homeDir, ".claude", "projects", escaped, "memory");
    try {
        const stat = fs.statSync(dir);
        if (!stat.isDirectory())
            return null;
        return dir;
    }
    catch {
        return null;
    }
}
function listMemoryFiles({ memoryDir, nowMs }) {
    if (typeof memoryDir !== "string" || !memoryDir)
        return [];
    const now = typeof nowMs === "number" ? nowMs : Date.now();
    let entries;
    try {
        entries = fs.readdirSync(memoryDir);
    }
    catch {
        return [];
    }
    const out = [];
    for (const name of entries) {
        if (!name.endsWith(".md"))
            continue;
        if (name.startsWith("."))
            continue;
        const full = path.join(memoryDir, name);
        let st;
        try {
            st = fs.statSync(full);
        }
        catch {
            continue;
        }
        if (!st.isFile())
            continue;
        const ageDays = Math.max(0, Math.floor((now - st.mtimeMs) / (1000 * 60 * 60 * 24)));
        out.push({
            name,
            path: full,
            size: st.size,
            mtimeMs: st.mtimeMs,
            ageDays,
        });
    }
    out.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return out;
}
function classifyMemoryFiles(files, { ageDaysThreshold = DEFAULT_ARCHIVE_AGE_DAYS } = {}) {
    const candidates = [];
    const recent = [];
    for (const f of (files || [])) {
        if (f.name === MEMORY_INDEX_NAME) {
            recent.push(f);
            continue;
        }
        if (f.ageDays >= ageDaysThreshold)
            candidates.push(f);
        else
            recent.push(f);
    }
    return { candidates, recent };
}
function archiveMemoryFiles({ memoryDir, files }) {
    if (typeof memoryDir !== "string" || !memoryDir)
        return [];
    if (!Array.isArray(files) || files.length === 0)
        return [];
    const archiveDir = path.join(memoryDir, ARCHIVE_DIRNAME);
    fs.mkdirSync(archiveDir, { recursive: true });
    const moved = [];
    for (const f of files) {
        if (!f || typeof f.path !== "string" || !f.path)
            continue;
        if (typeof f.name !== "string" || !f.name)
            continue;
        if (f.name === MEMORY_INDEX_NAME)
            continue;
        const dest = path.join(archiveDir, f.name);
        try {
            fs.renameSync(f.path, dest);
            moved.push({ name: f.name, from: f.path, to: dest });
        }
        catch {
            // Per-file move failure — skip and continue with remaining.
        }
    }
    return moved;
}
function unarchiveMemoryFiles(moves) {
    if (!Array.isArray(moves) || moves.length === 0)
        return [];
    const restored = [];
    for (const m of moves) {
        if (!m || typeof m.from !== "string" || typeof m.to !== "string")
            continue;
        try {
            fs.renameSync(m.to, m.from);
            restored.push({ name: m.name });
        }
        catch {
            // Undo window expired or archive dir vanished — skip.
        }
    }
    return restored;
}
function updateMemoryIndex({ memoryDir, archivedNames, restoredNames }) {
    if (typeof memoryDir !== "string" || !memoryDir)
        return { commented: 0, uncommented: 0 };
    const indexPath = path.join(memoryDir, MEMORY_INDEX_NAME);
    let text;
    try {
        text = fs.readFileSync(indexPath, "utf8");
    }
    catch {
        return { commented: 0, uncommented: 0 };
    }
    const lines = text.split("\n");
    const archivedSet = new Set(Array.isArray(archivedNames) ? archivedNames : []);
    const restoredSet = new Set(Array.isArray(restoredNames) ? restoredNames : []);
    let commented = 0;
    let uncommented = 0;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const wrappedMatch = /^<!--\s*\[gryphon-archived]\s*(.*?)\s*-->$/.exec(line);
        if (wrappedMatch) {
            const inner = wrappedMatch[1];
            if (_lineRefersToAny(inner, restoredSet)) {
                lines[i] = inner;
                uncommented += 1;
            }
            continue;
        }
        if (archivedSet.size > 0 && _lineRefersToAny(line, archivedSet)) {
            lines[i] = `<!-- [gryphon-archived] ${line} -->`;
            commented += 1;
        }
    }
    try {
        fs.writeFileSync(indexPath, lines.join("\n"));
    }
    catch (e) {
        const err = e;
        // Index write failed — files are still moved on disk, but the
        // index still references them. CC will 404 those names on every
        // future turn until the user fixes the index manually or re-runs
        // /memory. Surface the error so the caller can Notice it; the
        // earlier "silent degradation" framing under-stated the impact.
        return {
            commented,
            uncommented,
            indexWriteError: (err && err.message) || String(err),
        };
    }
    return { commented, uncommented };
}
function _lineRefersToAny(line, nameSet) {
    if (!nameSet || nameSet.size === 0)
        return false;
    if (typeof line !== "string" || !line)
        return false;
    for (const name of nameSet) {
        const bare = name.endsWith(".md") ? name.slice(0, -3) : name;
        if (line.includes(`(${name})`))
            return true;
        if (line.includes(`[[${bare}]]`))
            return true;
        if (line.includes(`[[${name}]]`))
            return true;
    }
    return false;
}
