/**
 * Untrusted-content framing builder (v0.6.0 Stage 5).
 *
 * Produces the `additionalContext` string that the PostToolUse hook
 * hands back to Claude Code. The string warns the model that the
 * preceding tool output came from an untrusted source and should be
 * treated as data, not instructions.
 *
 * Why a shared builder
 * --------------------
 * Anthropic API mode frames WebFetch/WebSearch output via the same wording (the
 * SDK path will later route through this module too). Keeping the
 * copy in one place prevents drift between modes and keeps the
 * security message consistent with what users see.
 *
 * Size target: ~150 bytes of base framing + short source attribution.
 * Framing tokens are effectively wasted on benign tool calls, so
 * brevity is a feature.
 */
/**
 * Human-readable labels for each tool. Used in the opening sentence
 * ("came from an external source via WebFetch", "from Bash stdout", etc.)
 */
declare const TOOL_LABELS: Record<string, string>;
/**
 * Build the `additionalContext` framing string.
 *
 * Copy discipline (v0.6.0 Stage 5 post-review):
 *   The model reads this string verbatim and tends to paraphrase it
 *   back to the user. To avoid leaking mechanism detail (hook names,
 *   pattern ids, "Gryphon detected X"), the framing talks only about
 *   the CONTENT'S trust level and the expected DISPOSITION. It does
 *   NOT name Gryphon, name the hook, name specific detectors, or give
 *   the model vocabulary it would otherwise repeat in chat.
 *
 *   Same rule as v0.5.14 applied to deny messages: the model should
 *   act on these instructions but speak about them in plain user
 *   language, not "the PostToolUse hook flagged X".
 *
 * @param {object} opts
 *   tool            — the CC tool name (e.g. "WebFetch")
 *   sourceDetail    — optional short string: URL, path, command preview
 *   injectionHits   — optional array of scanForInjectionMarkers results
 *                     (triggers sharper wording when non-empty)
 * @returns {string}
 */
declare function buildFraming({ tool, sourceDetail, injectionHits }?: {
    tool?: string;
    sourceDetail?: string;
    injectionHits?: unknown[];
}): string;
/**
 * Decide whether a given tool's output should be framed at all. Centralised
 * here so Anthropic API mode and the PostToolUse hook agree. Read-path nuance (in-vault
 * vs outside-vault, provenance-tagged vs untagged) is decided by the caller
 * before invoking buildFraming; this function's Read branch assumes the
 * caller already determined the file is in the "untrusted" bucket.
 */
declare function shouldFrame(tool: string): boolean;
export { buildFraming, shouldFrame, TOOL_LABELS, };
