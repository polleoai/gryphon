/**
 * Provenance store (v0.6.0 Stage 6).
 *
 * Persistent tag store for vault files that originated from untrusted
 * sources. A tagged file's Read result gets framed in PostToolUse
 * regardless of whether it's inside the vault root — the file's
 * CONTENT trust is what matters, not its filesystem location.
 *
 * Storage
 * -------
 * Single JSON file at `<pluginDir>/provenance.json`:
 *
 *   {
 *     "version": 1,
 *     "paths": {
 *       "notes/imported.md": {
 *         "source": "Write-after-WebFetch",
 *         "sourceUrl": "https://example.com/page",
 *         "taggedAt": "2026-04-20T18:03:12.000Z",
 *         "sessionId": "<cc-session-uuid>"
 *       }
 *     }
 *   }
 *
 * Keys are ALWAYS vault-relative POSIX paths (forward slashes, no
 * leading `/`). Callers normalise at the boundary so lookups don't
 * depend on how a path was expressed to the tool.
 *
 * Atomicity
 * ---------
 * Writes go to `provenance.json.<pid>.<rand>.tmp`, fsync, then rename.
 * A crash mid-write leaves either the previous good file or a stray
 * `.tmp` that `load()` ignores. `load()` is synchronous and cheap —
 * we call it on every mutation to stay consistent with manual edits
 * to provenance.json (e.g. a user clearing a specific entry by hand).
 *
 * Not Obsidian-aware
 * ------------------
 * This module only touches `fs` + `path`. It does NOT resolve paths,
 * enforce vault boundaries, or understand the vault adapter. That
 * logic lives in the IPC handler that calls into this store — the
 * store itself is a plain key-value persistence layer.
 *
 * Multi-instance behavior
 * -----------------------
 * Two Obsidian windows pointing at the same vault each have their own
 * plugin instance with their own ProvenanceStore holding the same
 * on-disk file. To keep concurrent tag additions from clobbering each
 * other, every mutation method (`add`, `remove`, `clear`) re-reads
 * the on-disk JSON before mutating. This shrinks the cross-instance
 * race window from "anywhere between initial load and persist" to
 * the microsecond slice inside a single mutation.
 *
 * A bulletproof fix would require an advisory lockfile around the
 * reload+mutate+persist critical section. We skip that for v0.6 on
 * the judgment that (a) multi-Obsidian-same-vault is an unusual
 * config, (b) a lost tag isn't catastrophic (the next tag-producing
 * operation re-tags the file), and (c) the reload-before-mutate
 * mitigation already reduces race probability by ~1000x.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const STORE_VERSION = 1;
const FILENAME = "provenance.json";
// Round-14 Q4 (lockfile): advisory lockfile used to serialize the
// read+mutate+persist critical section across concurrent Obsidian
// windows. We `openSync(..., "wx")` — O_EXCL semantics — so the second
// writer gets EEXIST and spin-retries. Total wait is bounded by
// LOCK_TIMEOUT_MS so a crashed plugin leaving a stale lock doesn't
// block the survivor forever.
const LOCKFILE = "provenance.json.lock";
// Lock acquisition budget: generous enough that two Obsidian windows
// racing hundreds of writes don't time out, tight enough that a hung
// lock holder surfaces as an error within seconds. Real-world expected
// contention is low — both windows share the vault but tag-producing
// events (WebFetch, Write-after-untrusted) are user-paced, not batched.
const LOCK_TIMEOUT_MS = 10_000;
// If the lockfile is older than this, assume the previous holder
// crashed and steal the lock. Must exceed the slowest legitimate
// mutation (reload + mutate + fsync + rename + unlink) by a wide margin.
const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_INITIAL_MS = 1;
const LOCK_RETRY_MAX_MS = 15;

class ProvenanceStore {
  /**
   * @param {string} pluginDir absolute path to the Gryphon plugin dir
   *   (where main.js lives). Provenance JSON is written alongside.
   */
  constructor(pluginDir) {
    if (typeof pluginDir !== "string" || pluginDir.length === 0) {
      throw new TypeError("ProvenanceStore: pluginDir must be a non-empty string");
    }
    this._pluginDir = pluginDir;
    this._file = path.join(pluginDir, FILENAME);
    this._lockFile = path.join(pluginDir, LOCKFILE);
    // In-memory cache. Load once; mutations invalidate-and-rewrite.
    this._data = { version: STORE_VERSION, paths: {} };
    this._loaded = false;
    // Round-8 F5: when load() can't read an existing file (EBUSY,
    // EACCES, EIO — i.e. anything that isn't "file doesn't exist"),
    // we MUST NOT silently treat the in-memory state as authoritative.
    // The next mutation would persist empty state and wipe whatever
    // is on disk. Track the failure and refuse to write until it
    // clears (next successful load).
    this._loadError = null;
  }

  /**
   * Load (or reload) state from disk. Tolerates a missing file
   * (returns empty state) and a malformed file (logs, returns empty
   * state — manual recovery beats data loss from a bad in-place
   * overwrite).
   */
  load() {
    // Best-effort sweep of stale tmp files from prior crashed writes
    // (Round-8 F8). Done here rather than in _persist so it runs once
    // at load and doesn't add latency to the hot write path.
    this._sweepStaleTmpFiles();
    this._reloadFromDisk();
  }

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
  _reloadFromDisk() {
    this._loadError = null;
    let raw;
    try {
      raw = fs.readFileSync(this._file, "utf8");
    } catch (e) {
      if (e.code === "ENOENT") {
        // Legitimate empty store — never written before.
        this._data = { version: STORE_VERSION, paths: {} };
        this._loaded = true;
        return true;
      }
      // EBUSY / EACCES / EIO / etc. — file exists but unreadable.
      // Round-8 F5: do NOT proceed as if the store is empty.
      // Mutations are blocked until the next successful load (see
      // _persist), so a transient FS issue can't silently destroy
      // months of accumulated tags.
      this._loadError = e;
      this._loaded = true;
      try { console.warn(`[gryphon/provenance] load failed (writes blocked until cleared): ${e.message}`); } catch (_) {}
      return false;
    }

    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.paths && typeof parsed.paths === "object") {
        this._data = {
          version: typeof parsed.version === "number" ? parsed.version : STORE_VERSION,
          paths: parsed.paths,
        };
      } else {
        // File parsed but didn't have expected shape — treat like a
        // corrupt file: leave the on-disk content alone, don't accept
        // mutations.
        this._loadError = new Error("provenance.json: missing or non-object 'paths' field");
        try { console.warn(`[gryphon/provenance] ${this._loadError.message}`); } catch (_) {}
      }
    } catch (e) {
      // Malformed JSON. Same posture as unreadable file — block writes
      // so we don't lose the on-disk content the user might want to
      // recover by hand.
      this._loadError = e;
      try { console.warn(`[gryphon/provenance] load failed (JSON parse): ${e.message}`); } catch (_) {}
    }
    this._loaded = true;
    return this._loadError === null;
  }

  /**
   * Has the most recent load() succeeded? Callers (settings UI) can
   * surface this so the user knows tagging is in a degraded state.
   */
  isLoadFailed() {
    if (!this._loaded) this.load();
    return this._loadError !== null;
  }

  /**
   * Returns a human-readable description of the current load failure,
   * or null when loading is healthy.
   */
  loadErrorMessage() {
    if (!this._loaded) this.load();
    return this._loadError ? this._loadError.message : null;
  }

  /**
   * Round-8 F8: clean up stray <file>.<pid>.<rand>.tmp leftovers from
   * crashed writes. Conservative — only removes files matching our
   * exact temp-name pattern AND older than 60s (so we never race a
   * concurrent writer in another Obsidian window). Failures are
   * logged and swallowed; sweeping is best-effort.
   */
  _sweepStaleTmpFiles() {
    const dir = this._pluginDir;
    const baseName = path.basename(this._file);
    // Pattern: provenance.json.<pid>.<8-hex>.tmp
    const tmpRe = new RegExp(`^${baseName.replace(/\./g, "\\.")}\\.\\d+\\.[0-9a-f]+\\.tmp$`);
    const cutoff = Date.now() - 60_000;
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch (_) {
      return;  // Plugin dir unreadable — nothing we can do here.
    }
    for (const name of entries) {
      if (!tmpRe.test(name)) continue;
      const full = path.join(dir, name);
      try {
        const stat = fs.statSync(full);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(full);
        }
      } catch (_) { /* best-effort */ }
    }
  }

  /**
   * Return true iff the given vault-relative path is tagged.
   */
  has(vaultRelPath) {
    if (!this._loaded) this.load();
    const key = _normaliseKey(vaultRelPath);
    return key ? Object.prototype.hasOwnProperty.call(this._data.paths, key) : false;
  }

  /**
   * Return the tag metadata for a path, or null if untagged.
   */
  get(vaultRelPath) {
    if (!this._loaded) this.load();
    const key = _normaliseKey(vaultRelPath);
    if (!key) return null;
    return this._data.paths[key] || null;
  }

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
  add(vaultRelPath, metadata) {
    const key = _normaliseKey(vaultRelPath);
    if (!key) throw new Error("ProvenanceStore.add: empty path");
    if (!metadata || typeof metadata !== "object") {
      throw new TypeError("ProvenanceStore.add: metadata must be an object");
    }
    if (typeof metadata.source !== "string" || !metadata.source) {
      throw new TypeError("ProvenanceStore.add: metadata.source required");
    }
    this._withLock(() => {
      if (!this._loaded) this.load(); else this._reloadFromDisk();
      this._data.paths[key] = {
        source: metadata.source,
        sourceUrl: metadata.sourceUrl || undefined,
        sourceCommand: metadata.sourceCommand || undefined,
        taggedAt: metadata.taggedAt || new Date().toISOString(),
        sessionId: metadata.sessionId || undefined,
      };
      this._persist();
    });
  }

  /**
   * Remove a tag. No-op if the path isn't tagged. Serialised across
   * processes via `_withLock` (see `add`).
   */
  remove(vaultRelPath) {
    const key = _normaliseKey(vaultRelPath);
    if (!key) return;
    this._withLock(() => {
      if (!this._loaded) this.load(); else this._reloadFromDisk();
      if (Object.prototype.hasOwnProperty.call(this._data.paths, key)) {
        delete this._data.paths[key];
        this._persist();
      }
    });
  }

  /**
   * Remove all tags. Serialised across processes via `_withLock`.
   */
  clear() {
    this._withLock(() => {
      if (!this._loaded) this.load(); else this._reloadFromDisk();
      this._data.paths = {};
      this._persist();
    });
  }

  /**
   * List all tagged paths (as objects `{path, metadata}`) for the
   * settings UI. Callers should not mutate the returned objects.
   */
  list() {
    if (!this._loaded) this.load();
    return Object.entries(this._data.paths).map(([p, metadata]) => ({
      path: p,
      metadata,
    }));
  }

  /**
   * Drop entries whose underlying files no longer exist on disk.
   * Returns the list of removed paths.
   *
   * Caller supplies the vault root since we store vault-relative
   * paths; this module doesn't know where the vault is.
   */
  lint(vaultRoot) {
    if (typeof vaultRoot !== "string" || !vaultRoot) {
      throw new TypeError("ProvenanceStore.lint: vaultRoot required");
    }
    let removed = [];
    // Round-14 Q4: wrap in lock so a concurrent writer can't sneak in
    // an add between our stat check and persist, causing its tag to
    // get dropped by our `for (... of Object.keys(this._data.paths))`
    // loop (reload-before-mutate picked it up, but we'd still drop it
    // if its file wasn't ready to stat yet).
    this._withLock(() => {
      if (!this._loaded) this.load(); else this._reloadFromDisk();
      removed = [];
      for (const relPath of Object.keys(this._data.paths)) {
        const absPath = path.join(vaultRoot, relPath);
        try {
          fs.statSync(absPath);
        } catch (e) {
          if (e.code === "ENOENT") {
            delete this._data.paths[relPath];
            removed.push(relPath);
          }
          // Any other error (permissions, etc.) → leave the entry; we
          // don't want to drop tags just because we can't stat.
        }
      }
      if (removed.length > 0) this._persist();
    });
    return { removed };
  }

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
  _withLock(fn) {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    let delay = LOCK_RETRY_INITIAL_MS;
    let acquired = false;
    while (!acquired) {
      try {
        const fd = fs.openSync(this._lockFile, "wx");
        try {
          fs.writeSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
        } catch (_) { /* best-effort payload */ }
        fs.closeSync(fd);
        acquired = true;
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
        // Check for stale lock
        try {
          const stat = fs.statSync(this._lockFile);
          if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
            try { fs.unlinkSync(this._lockFile); } catch (_) { /* another writer unlinked first */ }
            continue;  // try again immediately
          }
        } catch (_) { /* lockfile vanished between EEXIST and stat → loop retries */ }
        if (Date.now() >= deadline) {
          throw new Error(
            `ProvenanceStore: could not acquire lock within ${LOCK_TIMEOUT_MS}ms ` +
            `(another Obsidian instance may be holding it). The mutation was not applied.`,
          );
        }
        // Busy-wait with backoff. A microsleep is enough for the
        // concurrent writer to complete a single mutation.
        const start = Date.now();
        while (Date.now() - start < delay) { /* spin */ }
        delay = Math.min(delay * 2, LOCK_RETRY_MAX_MS);
      }
    }
    try {
      fn();
    } finally {
      try { fs.unlinkSync(this._lockFile); } catch (_) { /* ignore — stale-lock logic handles */ }
    }
  }

  /** Count of tagged paths. Cheap accessor for the settings UI. */
  size() {
    if (!this._loaded) this.load();
    return Object.keys(this._data.paths).length;
  }

  /**
   * Atomic write: temp file + fsync + rename. Never leaves a partial
   * provenance.json. On rename failure the temp file is best-effort
   * unlinked so we don't leak files.
   */
  _persist() {
    if (this._loadError) {
      // Round-8 F5: refuse to write while load is in a failed state.
      // Writing now would clobber the (presumably good) on-disk file
      // we just couldn't read. Surface the underlying error so the
      // caller knows the mutation didn't land.
      throw new Error(
        `provenance store write blocked: prior load failed (${this._loadError.message}). ` +
        `Restore or delete provenance.json then retry.`
      );
    }
    const tmp = `${this._file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    let fd;
    try {
      fd = fs.openSync(tmp, "w");
      fs.writeSync(fd, JSON.stringify(this._data, null, 2));
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(tmp, this._file);
    } catch (e) {
      if (fd != null) { try { fs.closeSync(fd); } catch (_) { /* ignore */ } }
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
      throw e;
    }
  }
}

/**
 * Normalise a path into the canonical vault-relative key form:
 * POSIX separators, no leading slash. Returns null for empty input.
 */
function _normaliseKey(p) {
  if (typeof p !== "string") return null;
  const trimmed = p.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\\/g, "/").replace(/^\/+/, "");
}

module.exports = {
  ProvenanceStore,
  STORE_VERSION,
  _normaliseKey,  // exported for tests
};
