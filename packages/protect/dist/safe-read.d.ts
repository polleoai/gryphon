type SafeRead = {
    raw: string;
    st: import("fs").Stats;
} | {
    raw: null;
    absent: boolean;
    error?: NodeJS.ErrnoException;
};
/**
 * `follow`: a store the user keeps as a symlink (dotfile managers do) is
 * read through the link — the target must still be a regular file. Gryphon's
 * OWN record is never read through a link (follow = false), and since the
 * record is always on disk, a link can't be used to pick a read error.
 */
declare function readRegularFile(file: string, opts?: {
    follow?: boolean;
}): SafeRead;
/**
 * Clear what sits at `p` when it isn't a regular file, without ever deleting
 * recursively (a planted directory or Windows junction is removed as one
 * entry, or moved aside).
 */
declare function clearNonFile(p: string): void;
export { readRegularFile, clearNonFile };
