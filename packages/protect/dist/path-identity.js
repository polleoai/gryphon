"use strict";
// TypeScript module marker.
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * R43-6: path checks by FILE IDENTITY, not by string.
 *
 * The same directory can be reached under several strings that realpath
 * doesn't collapse: macOS firmlinks (`/System/Volumes/Data/Users/…` is
 * `/Users/…`), Windows `\\?\C:\…`, `\\localhost\C$\…` and 8.3 short names, or
 * a vault opened through a symlinked folder. A string comparison misses all
 * of them. Here a candidate is "inside" a root when the candidate or one of
 * its existing ancestors IS the root (same device + inode), and is "the same
 * file" as a guarded file when it has the same device + inode (hard links).
 *
 * Node builtins only: this module is bundled into the store-guard hook.
 * Callers keep their string checks too; this only ever adds a refusal.
 */
const fs = require("fs");
const path = require("path");
const MAX_WALK = 128;
/** "dev:ino" of an existing path (following symlinks), or null. */
function fileId(p) {
    try {
        const st = fs.statSync(p, { bigint: true });
        // A filesystem that reports inode 0 (some network / FAT mounts) has no
        // usable identity — comparing it would match unrelated files.
        if (st.ino === BigInt(0))
            return null;
        return `${st.dev}:${st.ino}`;
    }
    catch (_) {
        return null;
    }
}
/** True when `candidate` (or an existing ancestor of it) is one of `roots`. */
function isWithinByIdentity(candidate, roots) {
    if (typeof candidate !== "string" || !candidate)
        return false;
    const ids = new Set(roots.map(fileId).filter((x) => !!x));
    if (!ids.size)
        return false;
    let cur = candidate;
    for (let i = 0; i < MAX_WALK; i++) {
        const id = fileId(cur);
        if (id && ids.has(id))
            return true;
        const parent = path.dirname(cur);
        if (parent === cur)
            return false;
        cur = parent;
    }
    return false;
}
/** True when `candidate` is the same file as one of `files` (incl. hard links). */
function sameFileAs(candidate, files) {
    const id = fileId(candidate);
    if (!id)
        return false;
    return files.some((f) => fileId(f) === id);
}
/**
 * When `candidate` lies under `root` by identity but not by string (another
 * name for the same directory), return the same location spelled from
 * `root`; null when it isn't under `root` at all.
 */
function rebaseOntoRoot(candidate, root) {
    if (typeof candidate !== "string" || !candidate || !path.isAbsolute(candidate))
        return null;
    const rootId = fileId(root);
    if (!rootId)
        return null;
    let cur = candidate;
    for (let i = 0; i < MAX_WALK; i++) {
        if (fileId(cur) === rootId)
            return path.join(root, path.relative(cur, candidate));
        const parent = path.dirname(cur);
        if (parent === cur)
            return null;
        cur = parent;
    }
    return null;
}
/** fileId with a per-check cache (candidates share most ancestors). */
function fileIdCached(p, cache) {
    if (!cache)
        return fileId(p);
    if (cache.has(p))
        return cache.get(p);
    const id = fileId(p);
    cache.set(p, id);
    return id;
}
/** isWithinByIdentity against precomputed root ids, with a shared cache. */
function isWithinIds(candidate, ids, cache) {
    if (typeof candidate !== "string" || !candidate || !ids.size)
        return false;
    let cur = candidate;
    for (let i = 0; i < MAX_WALK; i++) {
        const id = fileIdCached(cur, cache);
        if (id && ids.has(id))
            return true;
        const parent = path.dirname(cur);
        if (parent === cur)
            return false;
        cur = parent;
    }
    return false;
}
module.exports = { fileId, fileIdCached, isWithinByIdentity, isWithinIds, sameFileAs, rebaseOntoRoot };
