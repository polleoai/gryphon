/**
 * Consumer-owned memory carrier (issue #27, Part A).
 *
 * Scoped launches run with `--setting-sources=` (no settings files), and the
 * `project` source is also what makes Claude Code load the vault's
 * CLAUDE.md. A consumer that depends on its CLAUDE.md (Athena's immutable
 * security rules live there) names it in `claudeCodeScope.memoryFiles`;
 * Gryphon assembles one file and passes it as `--append-system-prompt-file`.
 *
 * `--append-system-prompt-file` doesn't expand `@path` imports (live-probed,
 * claude 2.1.292), so this does — the way Claude Code does natively:
 *   - relative to the importing file; `~` is NOT expanded
 *   - max depth 5; each file included once (cycle guard)
 *   - `@` inside fenced or inline code is not an import
 *   - a path that doesn't name an existing file is plain text, not an import
 * Containment: an import's realpath must stay under the directory of the
 * top-level memory file that started the chain; one that escapes is skipped
 * with a warning. Text concatenation only — nothing is executed.
 *
 * Pure apart from reading the named files: returns the text and the
 * problems; the provider writes the temp file and surfaces the problems.
 */
declare const MAX_IMPORT_DEPTH = 5;
/** Claude Code's own "large memory file" threshold. Warn, never truncate. */
declare const LARGE_MEMORY_CHARS = 40000;
interface MemoryAppendix {
    /** Concatenated memory text; "" when nothing could be read. */
    text: string;
    /** Top-level files that couldn't be read — their rules are NOT in effect. */
    missing: string[];
    /** Skipped imports, size warnings. Log-level. */
    warnings: string[];
}
/** `@path` tokens outside fenced and inline code, in document order. */
declare function findImports(text: string): string[];
declare function buildMemoryAppendix(files: string[]): MemoryAppendix;
/**
 * Write the assembled memory for `--append-system-prompt-file`. Same temp
 * family and flags as the --settings file (`wx` refuses a pre-planted
 * file/symlink, 0600 owner-only); the onload orphan sweep reaps crash
 * leftovers. The provider unlinks it when the CLI closes.
 */
declare function writeMemoryFile(text: string): string;
export { buildMemoryAppendix, writeMemoryFile, findImports, MAX_IMPORT_DEPTH, LARGE_MEMORY_CHARS };
export type { MemoryAppendix };
