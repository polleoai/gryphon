/**
 * Per-provider extraArgs filtering (issue #39).
 *
 * Background: GryphonChatView's `extraProcessArgs` option lets consumers
 * append flags to every CLI provider's spawn args. Today, every provider
 * blindly forwards them — so when a downstream consumer plugin wires up
 * Claude-Code-only flags like `--disable-slash-commands`, the codex-cli
 * and gemini-cli spawns fail with "unknown argument."
 *
 * This module centralizes per-provider knowledge of which flags belong
 * to which CLI, so each provider's adapter can drop cross-provider flags
 * before passing the rest to its own spawn.
 *
 * Conservative inclusion: only flags KNOWN to break a different
 * provider's spawn are listed here. A flag we haven't enumerated passes
 * through untouched, on the theory that consumers know what they're
 * doing for flags Gryphon doesn't recognize. The result is "drop the
 * obvious mismatches; trust the consumer for everything else."
 *
 * For consumers that want clean per-provider routing without relying on
 * this filter, the recommended path is `options.extraProcessArgsByProvider`
 * — see `src/providers/factory.js` for the merge logic.
 */
declare const PROVIDER_FLAGS: Record<string, Set<string>>;
declare const ALL_PROVIDER_FLAGS: Set<unknown>;
/**
 * Filter `extraArgs` for the active provider, dropping cross-provider
 * flags. Each flag is classified as:
 *   - "owned by my provider" → keep (and its value if any)
 *   - "owned by another provider" → drop (and its value if any)
 *   - "unknown / generic" → keep (consumer's call)
 *
 * Two flag forms are recognized:
 *   - Separate tokens: `--allowedTools Bash,Read` (two argv entries)
 *   - Inline value:    `--allowedTools=Bash,Read` (one argv entry)
 * Both forms classify identically — the classifier reads only the flag
 * name (everything before the first `=`).
 *
 * For the separate-tokens form, value detection: a token immediately
 * after a flag is treated as the flag's value if it doesn't itself start
 * with `--`. Edge case: `--flag` (no value) followed by `--anotherflag`
 * is correctly classified — the next-token-is-flag check matches, so
 * no value is consumed.
 *
 * @param {string[]} extraArgs       — the flat array of CLI tokens
 * @param {string}   providerKind    — active provider id ("claude-code", "codex-cli", "gemini-cli")
 * @returns {{ filtered: string[], dropped: string[] }}
 */
declare function filterExtraArgs(extraArgs: string[], providerKind: string): {
    filtered: string[];
    dropped: string[];
};
export { filterExtraArgs, PROVIDER_FLAGS, ALL_PROVIDER_FLAGS, };
