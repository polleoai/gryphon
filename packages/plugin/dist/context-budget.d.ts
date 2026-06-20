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
export {};
