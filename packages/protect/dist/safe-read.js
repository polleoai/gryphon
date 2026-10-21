"use strict";
// TypeScript module marker.
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
exports.readRegularFile = readRegularFile;
exports.clearNonFile = clearNonFile;
/**
 * Issue #32 (re-review of 0fd38d0): read a Gryphon store file — the
 * security settings, the MCP approvals, or their trusted copies — only if
 * it is a regular file.
 *
 * Gryphon only ever writes these by renaming a fresh regular file into
 * place, so anything else at the path (a directory, a FIFO, a socket, and —
 * for Gryphon's own record — a symlink) was not written by Gryphon and is
 * treated as ABSENT. That matters
 * twice over:
 *   - an agent could otherwise pick the read error (EISDIR, ELOOP) so the
 *     file read as "unreadable" instead of "missing", and get a later plant
 *     adopted instead of judged;
 *   - reading a FIFO blocks forever, freezing the Obsidian window.
 *
 * Opened with O_NONBLOCK (plus O_NOFOLLOW for Gryphon's own records) and checked with fstat on the same
 * descriptor, so the file can't be swapped between the check and the read.
 * Node builtins only: this module is bundled into the store-guard hook.
 */
const fs = __importStar(require("fs"));
// EISDIR at open: Windows refuses to open a directory (POSIX opens it and
// fstat says so below).
const ABSENT_CODES = new Set(["ENOENT", "ENOTDIR", "ELOOP", "EISDIR"]);
/**
 * `follow`: a store the user keeps as a symlink (dotfile managers do) is
 * read through the link — the target must still be a regular file. Gryphon's
 * OWN record is never read through a link (follow = false), and since the
 * record is always on disk, a link can't be used to pick a read error.
 */
function readRegularFile(file, opts = {}) {
    const c = fs.constants;
    const flags = c.O_RDONLY | (opts.follow ? 0 : (c.O_NOFOLLOW || 0)) | (c.O_NONBLOCK || 0);
    let fd;
    try {
        fd = fs.openSync(file, flags);
    }
    catch (e) {
        const err = e;
        // ELOOP: the final component is a symlink (O_NOFOLLOW) — not Gryphon's.
        return { raw: null, absent: ABSENT_CODES.has(String(err.code)), error: err };
    }
    try {
        const st = fs.fstatSync(fd);
        if (!st.isFile())
            return { raw: null, absent: true };
        return { raw: fs.readFileSync(fd, "utf8"), st };
    }
    catch (e) {
        const err = e;
        return { raw: null, absent: err.code === "EISDIR", error: err };
    }
    finally {
        try {
            fs.closeSync(fd);
        }
        catch { /* already closed */ }
    }
}
/**
 * Clear what sits at `p` when it isn't a regular file, without ever deleting
 * recursively (a planted directory or Windows junction is removed as one
 * entry, or moved aside).
 */
function clearNonFile(p) {
    let st;
    try {
        st = fs.lstatSync(p);
    }
    catch {
        return;
    }
    if (st.isFile())
        return;
    try {
        fs.unlinkSync(p);
        return;
    }
    catch { /* a directory */ }
    try {
        fs.rmdirSync(p);
        return;
    }
    catch { /* not empty */ }
    try {
        fs.renameSync(p, `${p}.not-a-record-${process.pid}-${Date.now()}`);
    }
    catch { /* left; the write reports it */ }
}
