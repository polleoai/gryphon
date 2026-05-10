/**
 * Path validation for SDK-mode tools.
 *
 * SECURITY BOUNDARY — every tool that touches the filesystem MUST resolve
 * its input through `resolveVaultPath()` before any read/stat/write. This
 * is the only thing standing between a prompt-injected `file_path` and an
 * arbitrary-file-read on the user's machine.
 *
 * Rules:
 *   1. Final resolved path must be inside the vault root (after `..`,
 *      symlink, and absolute-path normalization).
 *   2. Relative paths resolve against the vault root.
 *   3. Absolute paths are accepted ONLY if they already point inside the
 *      vault (we don't auto-rewrite them).
 *   4. Symlinks that escape the vault are rejected (we resolve via
 *      fs.realpathSync where possible).
 */

const path = require("path");
const fs = require("fs");

class PathOutsideVaultError extends Error {
  constructor(requested, vaultRoot) {
    super(`Path resolves outside vault: ${requested} (vault: ${vaultRoot})`);
    this.name = "PathOutsideVaultError";
    this.requested = requested;
    this.vaultRoot = vaultRoot;
  }
}

/**
 * Resolve `requested` against `vaultRoot`, ensuring the result stays
 * inside the vault. Throws PathOutsideVaultError if it escapes.
 *
 * @param {string} requested  — path from tool input (relative or absolute)
 * @param {string} vaultRoot  — absolute path to the vault root
 * @returns {string} absolute, normalized, in-vault path
 */
function resolveVaultPath(requested, vaultRoot) {
  if (!requested || typeof requested !== "string") {
    throw new TypeError("resolveVaultPath: requested path must be a string");
  }
  if (!vaultRoot || typeof vaultRoot !== "string") {
    throw new TypeError("resolveVaultPath: vaultRoot must be a string");
  }

  const root = path.resolve(vaultRoot);
  const realRoot = fs.realpathSync(root);
  // Resolve relative against vault root; absolute paths normalize as-is.
  const candidate = path.resolve(root, requested);

  // Cheap lexical check first — rejects `..` escapes and absolute paths
  // outside the vault without any stat syscalls.
  if (!_isInside(candidate, root)) {
    throw new PathOutsideVaultError(requested, root);
  }

  // Walk up from the candidate until we find an existing ancestor, then
  // realpath that ancestor and re-compose with the non-existing tail.
  //
  // Why this matters: a Write creating `vault/trap/pwned.txt` where `trap`
  // is a symlink to `/etc/` would lexically look fine (candidate is inside
  // vault) but `fs.writeFileSync` would follow the symlink during the write.
  // Checking only `existsSync(candidate)` misses this because the leaf
  // doesn't exist yet. Resolving the dirname via realpath surfaces the
  // escape before any write happens.
  const suffix = [];
  let cursor = candidate;
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      // Reached filesystem root without finding any existing ancestor —
      // shouldn't happen because the vault root itself always exists, but
      // guard against an infinite loop on unusual filesystems.
      throw new PathOutsideVaultError(requested, root);
    }
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }

  let realCursor;
  try {
    realCursor = fs.realpathSync(cursor);
  } catch {
    // Broken symlink or transient error — treat as escape (fail closed).
    throw new PathOutsideVaultError(requested, root);
  }

  const realResolved = suffix.length
    ? path.join(realCursor, ...suffix)
    : realCursor;

  if (!_isInside(realResolved, realRoot)) {
    throw new PathOutsideVaultError(requested, root);
  }

  return realResolved;
}

function _isInside(child, parent) {
  const rel = path.relative(parent, child);
  // Empty string means child === parent (the vault root itself, allowed).
  // Otherwise rel must not start with ".." or be absolute.
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Classify a vault-relative path against a list of protected-path patterns.
 * A pattern ending in `/` is treated as a prefix (all files under that
 * directory are protected). A pattern without a trailing `/` is an
 * exact-match against the relative path.
 *
 * Path separators are normalized to forward slashes for cross-platform
 * matching — the default list uses forward slashes and user-provided
 * Windows-style entries are coerced to the same form.
 *
 * @param {string} vaultRel — vault-relative path (forward-slash form)
 * @param {Array<string>} patterns — list of protected-path prefixes
 * @returns {string|null} the matching pattern, or null if not protected
 */
function matchProtectedPath(vaultRel, patterns) {
  if (!vaultRel || !Array.isArray(patterns)) return null;
  // CASE-INSENSITIVE by default. Windows (NTFS) and macOS (APFS
  // default) treat filenames case-insensitively — `.obsidian/` and
  // `.Obsidian/` resolve to the same file on those filesystems. A
  // case-sensitive comparison here let an attacker bypass the
  // protected-path check on Windows by writing ".Obsidian/plugins/
  // gryphon/data.json": the filesystem resolves to the protected
  // file, but strict-case `startsWith(".obsidian/plugins/gryphon/")`
  // returns false → tool call allowed → settings overwritten.
  //
  // Linux with case-sensitive filesystems could theoretically create
  // two distinct files `.obsidian/` and `.Obsidian/`, but no real
  // user workflow does that — protected patterns are identifier
  // prefixes, and a case variation of a protected identifier is
  // NEVER a legitimate separate path. Lowercasing uniformly is the
  // safer default across all platforms.
  const norm = String(vaultRel)
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .toLowerCase();
  for (const raw of patterns) {
    // Accept either plain strings or { pattern, ... } objects so callers
    // can pass DEFAULT_PROTECTED_PATHS directly without unwrapping.
    const value = typeof raw === "string"
      ? raw
      : (raw && typeof raw.pattern === "string" ? raw.pattern : null);
    if (!value) continue;
    const p = value.replace(/\\/g, "/").trim().toLowerCase();
    if (!p || p.startsWith("#")) continue;  // allow comments in the setting
    if (p.endsWith("/")) {
      if (norm === p.slice(0, -1) || norm.startsWith(p)) return value;
    } else {
      if (norm === p) return value;
    }
  }
  return null;
}

/**
 * Parse a newline-separated settings string into a pattern list, filtering
 * out blank lines and `#` comments. Kept for migrating users upgrading
 * from the v0.3.3 textarea setting to the v0.4.2 checklist structure.
 */
function parsePatternList(settingValue) {
  if (typeof settingValue !== "string") return [];
  return settingValue.split(/\r?\n/).map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

/**
 * Resolve the effective active-pattern list from settings + defaults.
 * Defaults are active unless listed in `disabled`. Customs are always
 * active when present (to deactivate, users remove them).
 *
 * Accepts defaults as either a string array OR an array of
 * `{ pattern, explanation }` objects (v0.4.3+). Returns a plain string
 * array — consumers (matchProtectedPath, regex compilation) don't care
 * about the explanation field.
 *
 * Non-array / bad shapes coerce to [] so malformed settings never throw
 * at tool-call time.
 */
function resolveActivePatterns(defaults, disabled, custom) {
  const defs = Array.isArray(defaults) ? defaults : [];
  const normalizedDefs = defs
    .map((d) => (typeof d === "string" ? d : (d && typeof d.pattern === "string" ? d.pattern : null)))
    .filter((p) => p && p.length > 0);
  const off = new Set(Array.isArray(disabled) ? disabled : []);
  const cust = Array.isArray(custom)
    ? custom.filter((p) => typeof p === "string" && p.length > 0)
    : [];
  return [...normalizedDefs.filter((p) => !off.has(p)), ...cust];
}

module.exports = {
  resolveVaultPath,
  PathOutsideVaultError,
  matchProtectedPath,
  parsePatternList,
  resolveActivePatterns,
};
