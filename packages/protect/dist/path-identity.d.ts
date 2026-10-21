/** "dev:ino" of an existing path (following symlinks), or null. */
declare function fileId(p: string): string | null;
/** True when `candidate` (or an existing ancestor of it) is one of `roots`. */
declare function isWithinByIdentity(candidate: string, roots: string[]): boolean;
/** True when `candidate` is the same file as one of `files` (incl. hard links). */
declare function sameFileAs(candidate: string, files: string[]): boolean;
/**
 * When `candidate` lies under `root` by identity but not by string (another
 * name for the same directory), return the same location spelled from
 * `root`; null when it isn't under `root` at all.
 */
declare function rebaseOntoRoot(candidate: string, root: string): string | null;
/** fileId with a per-check cache (candidates share most ancestors). */
declare function fileIdCached(p: string, cache?: Map<string, string | null>): string | null;
/** isWithinByIdentity against precomputed root ids, with a shared cache. */
declare function isWithinIds(candidate: string, ids: Set<string>, cache?: Map<string, string | null>): boolean;
export { fileId, fileIdCached, isWithinByIdentity, isWithinIds, sameFileAs, rebaseOntoRoot };
