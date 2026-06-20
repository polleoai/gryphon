/**
 * Provider factory — selects an LLMProvider implementation based on
 * settings + runtime availability.
 *
 * Selection logic (per ADR 0002 + ADR 0003):
 *   providerPreference = "auto"          → first available, in order:
 *                                           claude-code (CLI present)
 *                                           → anthropic-api (key present)
 *                                           → openai-api (key present)
 *                                           → google-api (key present)
 *                                           → null
 *                      = "claude-code"   → Claude Code CLI (or null if
 *                                           claudePath missing)
 *                      = "anthropic-api" → Anthropic API (or null if
 *                                           apiKey missing)
 *                      = "openai-api"    → OpenAI API (or null if
 *                                           openaiApiKey missing).
 *                                           v1.2.0: Stage 1 returns null
 *                                           even when key is present —
 *                                           the OpenAIProvider class lands
 *                                           in Stage 2 (#17).
 *                      = "google-api"    → Google Gemini API (or null if
 *                                           googleApiKey missing).
 *                                           v1.2.0: Stage 1 returns null
 *                                           even when key is present —
 *                                           the GoogleProvider class lands
 *                                           in Stage 3 (#18).
 *
 * Returning null from createProvider is a soft failure — the caller
 * (chat-view) is responsible for surfacing setup guidance to the user
 * via explainUnavailable().
 *
 * The "auto" tiebreaker prefers claude-code when available because the
 * security guarantee is strongest there (full 27-event hook surface).
 * The other three SDK modes (anthropic-api / openai-api / google-api)
 * carry the same two-axis security via shared permission-IPC + attack-
 * detector, but no extra hook layer.
 */
export {};
