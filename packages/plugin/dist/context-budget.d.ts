/**
 * Context budget estimator (v1.7.0 F1).
 *
 * Two functions, separated by cost profile:
 *
 *   collectContextSources({...})    — async, filesystem I/O, called once
 *                                     per session-state change (model change,
 *                                     /new, /clear, model selection toggle).
 *
 *   summarizeContext({...})         — pure, no I/O, called on every input
 *                                     keystroke (debounced) to update the
 *                                     projection chip.
 *
 * The split keeps the per-keystroke path cheap while still letting the chip
 * reflect the cumulative system-prompt cost (which doesn't change between
 * spawns and shouldn't be re-stat'd on every keyup).
 *
 * Why we estimate at all: `claudeProcess.contextTokens` is only set AFTER
 * the LLM reports usage back. Fresh sessions, overflow failures, and the
 * first message of a session all show 0% in the meter even when the actual
 * prompt is huge. The estimator gives the user a meaningful number from
 * message #1, plus a per-source breakdown so they know which lever to pull.
 *
 * Accuracy goal: within ~15% of the post-turn measured tokens for CLI mode
 * (heuristic), exact for SDK mode (countTokens). Self-tuning calibration
 * (Stage D) sharpens this over time.
 */
interface ContextSourcesSnapshot {
    ccSystemPromptTokens: number;
    toolSchemaTokens: number;
    userClaudeMdTokens: number;
    homeClaudeMdTokens: number;
    vaultClaudeMdTokens: number;
    vaultAgentsMdTokens: number;
    memoryMdTokens: number;
    memoryDirTokens: number;
    memoryFileCount: number;
}
interface ContextProjection {
    totalTokens: number;
    pct: number;
    rawPct: number;
    bySource: Omit<ContextSourcesSnapshot, "memoryFileCount"> & {
        chatHistoryTokens: number;
        userInputTokens: number;
    };
    likelyOverflow: boolean;
    windowSize: number;
}
declare const CHARS_PER_TOKEN = 0.25;
declare const CC_SYSTEM_PROMPT_TOKENS_BASELINE = 1500;
declare const CC_TOOL_SCHEMAS_TOKENS_BASELINE = 2500;
declare const SDK_SYSTEM_PROMPT_TOKENS_BASELINE = 300;
declare const SDK_TOOL_SCHEMAS_TOKENS_BASELINE = 800;
/**
 * Approximate token count of a UTF-8 string using the chars/4 heuristic.
 * Centralized so calibration can slot a multiplier in one place later.
 */
declare function estimateTokensFromChars(text: unknown): number;
/**
 * Approximate token count from a byte size (assumes UTF-8, ~1 byte per
 * char for ASCII-dominated content like CLAUDE.md / source files).
 */
declare function estimateTokensFromBytes(bytes: unknown): number;
/**
 * Convert the vault's absolute path to CC's "escaped" project directory
 * name. CC writes auto-memory under
 *   ~/.claude/projects/<escapedAbsPath>/memory/
 * where `escapedAbsPath` is the absolute path with every `/` replaced by
 * `-`. Mirror that transformation here so we can locate the memory dir
 * without spawning CC.
 *
 * Cross-platform note: on Windows, paths use `\\` and a drive letter
 * (`C:\\Users\\foo\\vault`). CC normalizes Windows paths to forward
 * slashes before escaping, so we do the same here.
 */
declare function escapeVaultPath(absVaultPath: unknown): string;
/**
 * Snapshot the filesystem inputs that contribute to the model's context
 * budget. Async because each `safeStatBytes` is cheap but `sumDirMarkdownBytes`
 * may iterate dozens of memory files.
 *
 * @param {Object} args
 * @param {string} args.kind       provider kind — "claude-code" / "anthropic-api" / etc.
 * @param {string} args.vaultPath  absolute path to the active vault
 * @param {string} [args.homeDir]  override for tests; defaults to os.homedir()
 * @param {Object} [args.settings] active settings (for future MCP toggles)
 * @returns {Promise<ContextSourcesSnapshot>}
 *
 * @typedef {Object} ContextSourcesSnapshot
 * @property {number} ccSystemPromptTokens   — built-in CC prompt baseline
 * @property {number} toolSchemaTokens       — CC/SDK tool definitions baseline
 * @property {number} userClaudeMdTokens     — ~/.claude/CLAUDE.md
 * @property {number} homeClaudeMdTokens     — ~/CLAUDE.md
 * @property {number} vaultClaudeMdTokens    — <vault>/CLAUDE.md
 * @property {number} vaultAgentsMdTokens    — <vault>/AGENTS.md
 * @property {number} memoryMdTokens         — auto-memory MEMORY.md (capped at 24KB by CC)
 * @property {number} memoryDirTokens        — sum of *.md in memory dir (worst case)
 * @property {number} memoryFileCount        — # of `.md` files in memory dir (for UI)
 */
declare function collectContextSources({ kind, vaultPath, homeDir }: {
    kind?: string;
    vaultPath?: string | null;
    homeDir?: string | null;
    settings?: unknown;
}): Promise<ContextSourcesSnapshot>;
/**
 * Combine the filesystem snapshot with the live per-keystroke inputs
 * (chat history + user input) and return the projection used by the
 * chip + breakdown popover. Pure function — no I/O, safe to call from
 * a 300ms-debounced keyup handler.
 *
 * @param {Object} args
 * @param {ContextSourcesSnapshot} args.sources       — from collectContextSources
 * @param {Array<{text:string}>}   args.messages      — Gryphon-tracked chat history (SDK mode primarily; CLI mode uses post-turn measurement for history)
 * @param {string}                 args.userInput     — current input-box contents
 * @param {number}                 args.windowSize    — model's context window in tokens
 * @param {number}                 [args.measuredHistoryTokens]  — when CC has reported actual history tokens, use this instead of estimating from messages
 * @param {number}                 [args.calibrationDelta]       — Stage D self-tuning offset (positive = our estimator under-counts; add this)
 * @returns {ContextProjection}
 *
 * @typedef {Object} ContextProjection
 * @property {number} totalTokens
 * @property {number} pct                — clamp(0, 100)
 * @property {number} rawPct             — uncapped (can exceed 100 — useful for the popover)
 * @property {Object} bySource           — same keys as ContextSourcesSnapshot, plus chatHistory + userInput
 * @property {boolean} likelyOverflow    — totalTokens > windowSize * 0.95
 */
declare function summarizeContext({ sources, messages, userInput, windowSize, measuredHistoryTokens, calibrationDelta }: {
    sources?: Partial<ContextSourcesSnapshot> | null;
    messages?: Array<{
        text?: unknown;
    } | null | undefined> | null;
    userInput?: unknown;
    windowSize?: unknown;
    measuredHistoryTokens?: unknown;
    calibrationDelta?: unknown;
}): ContextProjection;
export { collectContextSources, summarizeContext, estimateTokensFromChars, estimateTokensFromBytes, escapeVaultPath, CHARS_PER_TOKEN, CC_SYSTEM_PROMPT_TOKENS_BASELINE, CC_TOOL_SCHEMAS_TOKENS_BASELINE, SDK_SYSTEM_PROMPT_TOKENS_BASELINE, SDK_TOOL_SCHEMAS_TOKENS_BASELINE, };
