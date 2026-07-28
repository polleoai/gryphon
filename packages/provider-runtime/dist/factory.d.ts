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
import type { LLMProvider, ProviderKind } from "./types";
/**
 * @param {object} pluginOrBag  — either:
 *   (a) Legacy positional form: the GryphonPlugin instance (we read settings).
 *       Second and third args are `cwd` and `options` respectively.
 *   (b) Headless options-bag form (new): plain object with shape:
 *         { kind, config, cwd?, options?, hostAdapter? }
 *       Detection: if pluginOrBag.kind is a string and pluginOrBag.settings
 *       is absent, we treat it as the bag form.
 * @param {string} [cwd]        — (legacy form) vault root for the provider
 * @param {object} [options={}] — (legacy form) per-turn options
 *
 *   `claudePath` is read from settings, NOT from options — it's a
 *   provider-selection input, not a per-turn override.
 *
 * @returns {object|null}     — LLMProvider instance, or null if no
 *                              provider can be constructed (caller shows
 *                              setup guidance).
 */
declare function createProvider(pluginOrBag: any, cwd?: string, options?: Record<string, any>): LLMProvider | null;
/**
 * Construct a provider for an EXPLICIT kind (issue #15 failover kernel).
 *
 * Unlike createProvider, this ignores `settings.providerPreference` — the
 * caller (the failover orchestrator, or a headless consumer wiring its own
 * one-hop failover) names the kind directly. It reads the same key/CLI
 * fields createProvider does, so the fallback resolves credentials the same
 * way, and accepts an optional `modelOverride` so the orchestrator can build
 * the fallback at its configured model WITHOUT mutating settings.
 *
 * Returns null when the kind has no usable key/CLI — same soft-failure
 * contract as createProvider.
 */
declare function createProviderForKind(plugin: any, kind: ProviderKind, cwd?: string, options?: Record<string, any>, modelOverride?: string): LLMProvider | null;
/**
 * The registry default model id for a provider kind's vendor. Used by
 * resolveFallback when `settings.fallbackModel` is unset.
 */
declare function defaultModelForKind(kind: string): string;
/**
 * Resolve the user-configured failover target (issue #15).
 *
 * Reads `settings.fallbackProviderPreference` / `settings.fallbackModel`:
 *   - "none"            → null (failover explicitly disabled).
 *   - unset/empty       → built-in default: claude-code IFF a `claude` binary
 *                         is detected, else null (the witnessed-bug fix path).
 *   - "auto"            → first available provider (same order as createProvider).
 *   - an explicit kind  → that kind (availability is the orchestrator's job;
 *                         an explicit user choice is taken at face value).
 * Model defaults to the fallback provider's registry default when
 * `fallbackModel` is unset. Pure over `plugin.settings` + binary detection —
 * no chat-view dependency, so headless consumers can call it directly.
 */
declare function resolveFallback(plugin: any): {
    kind: ProviderKind;
    model: string;
} | null;
/**
 * Returns a human-readable explanation of why createProvider returned
 * null, used by chat-view to surface a setup hint to the user.
 */
declare function explainUnavailable(plugin: any): string;
/**
 * Inspect what's available right now, regardless of the user's selected
 * preference. Used by the welcome panel to render adaptive guidance:
 * if a local `claude` CLI is detected, offer a one-click "Use local CLI"
 * button; if an API key is found anywhere, offer a one-click
 * "Use Anthropic API" button.
 *
 * Important caveat about env-var detection: process.env reflects whatever
 * environment Obsidian was launched with. macOS GUI launches (Finder,
 * Spotlight, Dock) do NOT source ~/.zshrc / ~/.bashrc — only terminal
 * launches do. So an env var the user added to .zshrc won't be visible
 * here unless they relaunch Obsidian via `open -a Obsidian` from a
 * fresh terminal. The settings field always works.
 *
 * @param {object} plugin — the GryphonPlugin instance
 * @returns {{
 *   cliPath: string|null,
 *   apiKey: string,
 *   apiKeySource: "settings" | "env" | null,
 * }}
 */
declare function detectAvailable(plugin: any): {
    cliPath: any;
    apiKey: string;
    apiKeySource: string | null;
    openaiKey: string;
    openaiKeySource: string | null;
    googleKey: string;
    googleKeySource: string | null;
    codexPath: any;
    geminiCliPath: any;
    antigravityPath: any;
};
/**
 * Returns the resolved provider kind that createProvider would pick for the
 * current settings + environment, WITHOUT actually instantiating anything.
 *
 * Used by UI surfaces (toolbar model button, model menu, Settings tab Default
 * model dropdown) that need to know "which provider's model list applies?"
 * even before a chat turn has spawned a real provider instance. The literal
 * `providerPreference` setting is NOT enough — `auto` resolves dynamically
 * based on which key/CLI is available, and the UI must mirror that.
 *
 * Returns one of: "claude-code" | "anthropic-api" | "openai-api" | "google-api" | null.
 * Mirrors createProvider's selection logic exactly (any divergence = bug).
 */
declare function getActiveProviderKind(plugin: any): ProviderKind | null;
export { createProvider, explainUnavailable, detectAvailable, getActiveProviderKind, createProviderForKind, resolveFallback, defaultModelForKind, };
