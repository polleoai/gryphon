declare class PathOutsideVaultError extends Error {
    requested: string;
    vaultRoot: string;
    constructor(requested: string, vaultRoot: string);
}
/**
 * Resolve `requested` against `vaultRoot`, ensuring the result stays
 * inside the vault. Throws PathOutsideVaultError if it escapes.
 *
 * @param {string} requested  — path from tool input (relative or absolute)
 * @param {string} vaultRoot  — absolute path to the vault root
 * @returns {string} absolute, normalized, in-vault path
 */
declare function resolveVaultPath(requested: string, vaultRoot: string): string;
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
declare function matchProtectedPath(vaultRel: string, patterns: Array<string | {
    pattern: string;
}>): string | null;
/**
 * Parse a newline-separated settings string into a pattern list, filtering
 * out blank lines and `#` comments. Kept for migrating users upgrading
 * from the v0.3.3 textarea setting to the v0.4.2 checklist structure.
 */
declare function parsePatternList(settingValue: unknown): string[];
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
declare function resolveActivePatterns(defaults: unknown, disabled: unknown, custom: unknown): string[];
export { resolveVaultPath, PathOutsideVaultError, matchProtectedPath, parsePatternList, resolveActivePatterns, };
