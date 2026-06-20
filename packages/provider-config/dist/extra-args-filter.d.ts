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
export {};
