/**
 * For each built-in protected-command regex we ship, this map supplies
 * the CC glob rules that approximate it. Keys are the raw regex
 * strings as stored in `DEFAULT_PROTECTED_COMMANDS[i].pattern`. Values
 * are arrays of glob rules.
 *
 * Adding a new default command pattern? Add its glob translation here
 * too — the CLI provider falls back to a generic `Bash(*<keyword>*)`
 * attempt for unmapped patterns, which is strictly worse than an
 * intentional translation.
 */
declare const CC_GLOBS_FOR_COMMAND_PATTERN: Map<string, string[]>;
/**
 * Translate one protected PATH entry (plain string or { pattern, ... }
 * object) into CC glob rules for the Write and Edit tools.
 */
declare function _globsForPath(entry: unknown): string[];
/**
 * Extract a rough keyword from a custom user regex so we can at least
 * make an attempt at a glob rule. We look for the first contiguous
 * run of alphanumerics (plus `-`, `/`, `.`) that's longer than 2
 * characters — that's usually enough to catch a prefix or command
 * name. If nothing clean comes out, return "" so the caller skips.
 */
declare function _extractKeyword(regex: unknown): string;
declare function _globsForCommand(entry: unknown): string[];
declare function buildApprovalsStoreDenyGlobs(): string[];
/**
 * Build the full CC `--disallowedTools` glob array for the user's
 * active protected-pattern selections.
 *
 * @param {object} security — the spawn's security snapshot (issue #29)
 * @returns {string[]}        — CC glob rules, empty if nothing active
 */
declare function buildDisallowedTools(security: Record<string, unknown> | null | undefined): string[];
export { buildDisallowedTools, buildApprovalsStoreDenyGlobs, _globsForPath, _globsForCommand, _extractKeyword, CC_GLOBS_FOR_COMMAND_PATTERN, };
