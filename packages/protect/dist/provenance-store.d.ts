declare const STORE_VERSION = 1;
declare class ProvenanceStore {
    _pluginDir: string;
    _file: string;
    _lockFile: string;
    _data: {
        version: number;
        paths: Record<string, unknown>;
    };
    _loaded: boolean;
    _loadError: Error | null;
    /**
     * @param {string} pluginDir absolute path to the Gryphon plugin dir
     *   (where main.js lives). Provenance JSON is written alongside.
     */
    constructor(pluginDir: string);
    /**
     * Load (or reload) state from disk. Tolerates a missing file
     * (returns empty state) and a malformed file (logs, returns empty
     * state — manual recovery beats data loss from a bad in-place
     * overwrite).
     */
    load(): void;
    /**
     * Cheap refresh of in-memory state from disk WITHOUT the tmp-file
     * sweep. Called at the top of every mutation so concurrent writers
     * in another Obsidian instance (multi-window on the same vault) see
     * each other's tags instead of racing to clobber them. Narrows the
     * cross-instance write race from "anywhere between initial load and
     * persist" to the microsecond slice inside a single mutation method.
     *
     * Returns true on a healthy load, false on error (_loadError is set).
     */
    _reloadFromDisk(): boolean;
    /**
     * Has the most recent load() succeeded? Callers (settings UI) can
     * surface this so the user knows tagging is in a degraded state.
     */
    isLoadFailed(): boolean;
    /**
     * Returns a human-readable description of the current load failure,
     * or null when loading is healthy.
     */
    loadErrorMessage(): string | null;
    /**
     * Round-8 F8: clean up stray <file>.<pid>.<rand>.tmp leftovers from
     * crashed writes. Conservative — only removes files matching our
     * exact temp-name pattern AND older than 60s (so we never race a
     * concurrent writer in another Obsidian window). Failures are
     * logged and swallowed; sweeping is best-effort.
     */
    _sweepStaleTmpFiles(): void;
    /**
     * Return true iff the given vault-relative path is tagged.
     */
    has(vaultRelPath: string): boolean;
    /**
     * Return the tag metadata for a path, or null if untagged.
     */
    get(vaultRelPath: string): unknown;
    /**
     * Add a tag for a vault-relative path. Overwrites any existing tag
     * for the same path. Writes to disk atomically before returning.
     *
     * Multi-instance safety: the read+mutate+persist cycle is serialised
     * across processes by `_withLock`. Without the lock, two Obsidian
     * windows writing concurrently lost 50-73% of tags (empirically
     * measured). With the lock, concurrent writers serialise and every
     * add survives.
     *
     * @param {string} vaultRelPath
     * @param {object} metadata { source, sourceUrl?, sourceCommand?, sessionId? }
     */
    add(vaultRelPath: string, metadata: {
        source: string;
        sourceUrl?: string;
        sourceCommand?: string;
        taggedAt?: string;
        sessionId?: string;
    }): void;
    /**
     * Remove a tag. No-op if the path isn't tagged. Serialised across
     * processes via `_withLock` (see `add`).
     */
    remove(vaultRelPath: string): void;
    /**
     * Remove all tags. Serialised across processes via `_withLock`.
     */
    clear(): void;
    /**
     * List all tagged paths (as objects `{path, metadata}`) for the
     * settings UI. Callers should not mutate the returned objects.
     */
    list(): {
        path: string;
        metadata: unknown;
    }[];
    /**
     * Drop entries whose underlying files no longer exist on disk.
     * Returns the list of removed paths.
     *
     * Caller supplies the vault root since we store vault-relative
     * paths; this module doesn't know where the vault is.
     */
    lint(vaultRoot: string): {
        removed: string[];
    };
    /**
     * Cross-process advisory lock. Creates `provenance.json.lock` with
     * `O_EXCL` (Node's "wx" flag). A concurrent writer in another
     * Obsidian window gets EEXIST and retries with exponential backoff
     * up to LOCK_RETRY_MAX_MS, bounded by LOCK_TIMEOUT_MS.
     *
     * Stale-lock handling: if the lockfile's mtime is older than
     * LOCK_STALE_MS, we assume the previous holder crashed and
     * unlink+retry. The window for a false stale-kill is LOCK_STALE_MS
     * of legitimate work, which is far longer than any real mutation
     * (mutations are small synchronous writes).
     *
     * Payload: the lockfile holds `<pid>\n<iso-timestamp>` so a human
     * can inspect who holds it during debugging. Not used for logic.
     *
     * Throws if the lock can't be acquired within LOCK_TIMEOUT_MS. The
     * mutator callbacks catch at the IPC boundary and report the error
     * to the hook; user-visible symptom: a single failed tag write, not
     * a cascading failure.
     */
    _withLock(fn: () => void): void;
    /** Count of tagged paths. Cheap accessor for the settings UI. */
    size(): number;
    /**
     * Atomic write: temp file + fsync + rename. Never leaves a partial
     * provenance.json. On rename failure the temp file is best-effort
     * unlinked so we don't leak files.
     */
    _persist(): void;
}
/**
 * Normalise a path into the canonical vault-relative key form:
 * POSIX separators, no leading slash. Returns null for empty input.
 */
declare function _normaliseKey(p: unknown): string | null;
export { ProvenanceStore, STORE_VERSION, _normaliseKey, };
