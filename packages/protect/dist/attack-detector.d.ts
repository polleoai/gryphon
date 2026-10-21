import type { ClassifyVerdict } from "./types";
import { TOOL_ALIASES } from "./tool-aliases";
/** A protected-pattern definition (built-in entry or user-added regex). */
interface PatternDef {
    pattern: string;
    category?: string;
    userRisk?: string;
    explanation?: string;
}
/**
 * Merge the user's disabled + custom settings with the built-in defaults
 * and return the set of active pattern definitions, each still carrying
 * its category / userRisk / explanation metadata. Mirrors
 * `resolveActivePatterns` in path-utils but preserves the metadata fields
 * (that function returns plain strings for regex compilation).
 */
declare function _activePatternDefs(defaults: unknown, disabled: unknown, custom: unknown): PatternDef[];
declare function _categoryTitle(category: string | undefined): string;
declare function classify(tool: string, input: Record<string, unknown> | null, ctx?: Record<string, unknown> | null): ClassifyVerdict;
declare function gate(classification: ReturnType<typeof classify>, opts: Record<string, unknown>): Promise<{
    allow: boolean;
    reason: string;
}>;
/**
 * Public helper: normalize a provider-specific tool name to the
 * Claude-Code vocabulary. Returns the input unchanged when no alias
 * is registered. Exposed because `_handleClassifyRequest` in
 * plugin.js needs to make the same isMutating / kind decisions
 * `classify()` makes internally — without it, the Bash/PowerShell
 * branches there fail to fire for Gemini's `run_shell_command`,
 * the modal-construction picks wrong kind, and the user sees a
 * generic deny instead of the category-specific reason
 * ("(destructive operation)"). User report 2026-05-03.
 */
declare function normalizeToolName(tool: string): string;
export { classify, gate, normalizeToolName, _activePatternDefs, _categoryTitle, TOOL_ALIASES, };
