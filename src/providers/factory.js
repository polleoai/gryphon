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

const { ClaudeCodeProvider } = require("./claude-code/claude-code");
const { AnthropicAPIProvider } = require("./anthropic-api/anthropic-api");
const { OpenAIProvider } = require("./openai-api/openai-api");
const { GoogleProvider } = require("./google-api/google-api");
const { DEFAULT_PROVIDER_PREFERENCE } = require("../constants");

/**
 * @param {object} plugin     — the GryphonPlugin instance (we read settings)
 * @param {string} cwd        — vault root for the provider
 * @param {object} options    — per-turn options:
 *   { model, effort, permissionMode, resumeSessionId, extraArgs, ... }
 *
 *   `claudePath` is read from settings, NOT from options — it's a
 *   provider-selection input, not a per-turn override.
 *
 * @returns {object|null}     — LLMProvider instance, or null if no
 *                              provider can be constructed (caller shows
 *                              setup guidance).
 */
function createProvider(plugin, cwd, options = {}) {
  const settings = plugin.settings || {};
  const preference = settings.providerPreference || DEFAULT_PROVIDER_PREFERENCE;
  const claudePath = settings.claudePath || _detectClaudeBinary();
  const apiKey = settings.anthropicApiKey || process.env.ANTHROPIC_API_KEY || "";
  const openaiKey = settings.openaiApiKey || process.env.OPENAI_API_KEY || "";
  const googleKey = settings.googleApiKey || process.env.GOOGLE_API_KEY || "";

  // claude-code provider receives `plugin` too, so it can read the
  // active protected-path / protected-command settings and translate
  // them to Claude Code's `--disallowedTools` flags on spawn.
  if (preference === "claude-code") {
    if (!claudePath) return null;
    return new ClaudeCodeProvider(claudePath, cwd, { ...options, plugin });
  }

  if (preference === "anthropic-api") {
    if (!apiKey) return null;
    return new AnthropicAPIProvider(apiKey, cwd, { ...options, plugin });
  }

  // openai-api: Stage 2 (#17) shipped — real OpenAIProvider when key present.
  if (preference === "openai-api") {
    if (!openaiKey) return null;
    return new OpenAIProvider(openaiKey, cwd, { ...options, plugin });
  }

  // google-api: Stage 3 (#18) shipped — real GoogleProvider when key present.
  if (preference === "google-api") {
    if (!googleKey) return null;
    return new GoogleProvider(googleKey, cwd, { ...options, plugin });
  }

  // auto: claude-code wins if available (subscription path is no extra
  // cost per prompt and has the full hook surface). Then any HTTP-API
  // key in the order: anthropic → openai → google.
  if (claudePath) return new ClaudeCodeProvider(claudePath, cwd, { ...options, plugin });
  if (apiKey)     return new AnthropicAPIProvider(apiKey, cwd, { ...options, plugin });
  if (openaiKey)  return new OpenAIProvider(openaiKey, cwd, { ...options, plugin });
  if (googleKey)  return new GoogleProvider(googleKey, cwd, { ...options, plugin });
  return null;
}

/**
 * Returns a human-readable explanation of why createProvider returned
 * null, used by chat-view to surface a setup hint to the user.
 */
function explainUnavailable(plugin) {
  const settings = plugin.settings || {};
  // Round 15 fix (F20): single source of truth for the default. Previously
  // createProvider used "auto" while explainUnavailable used "anthropic-api"
  // — those two assumptions diverged in the settings-corruption /
  // pre-DEFAULT-merge edge case.
  const preference = settings.providerPreference || DEFAULT_PROVIDER_PREFERENCE;
  const hasCli = !!(settings.claudePath || _detectClaudeBinary());
  const hasKey = !!(settings.anthropicApiKey || process.env.ANTHROPIC_API_KEY);
  const hasOpenAiKey = !!(settings.openaiApiKey || process.env.OPENAI_API_KEY);
  const hasGoogleKey = !!(settings.googleApiKey || process.env.GOOGLE_API_KEY);

  if (preference === "claude-code" && !hasCli) {
    return _cliNotFoundMessage();
  }
  if (preference === "anthropic-api" && !hasKey) {
    return "Anthropic API key not set. Paste a key in Settings → Gryphon → " +
           "Anthropic API key.";
  }
  // openai-api: Stage 2 shipped, so a key-missing case is the only
  // blocker. (Once Stage 3 ships, the symmetric google-api copy will
  // also drop its "being implemented" hint.)
  if (preference === "openai-api") {
    if (!hasOpenAiKey) {
      return "OpenAI API key not set. Paste a key in Settings → Gryphon → " +
             "OpenAI API key.";
    }
    // Should not reach here when key is present + adapter exists; defensive.
    return "OpenAI provider failed to initialize. Check your API key.";
  }
  if (preference === "google-api") {
    if (!hasGoogleKey) {
      return "Google API key not set. Paste a key in Settings → Gryphon → " +
             "Google API key.";
    }
    // Stage 3 shipped — defensive fallback for construction failure.
    return "Google provider failed to initialize. Check your API key.";
  }

  // auto-fallthrough with NO key/CLI at all. All three SDK adapters now
  // shipped — claude-code preserved as preferred when CLI is detected.
  return (
    "No provider available. Set up any of:\n" +
    "  • Claude Code CLI (install `claude`, then choose Claude Code in " +
    "Settings → Gryphon → Provider).\n" +
    "  • Anthropic API key (paste in Settings → Gryphon → Anthropic " +
    "API key — recommended).\n" +
    "  • OpenAI API key (paste in Settings → Gryphon → OpenAI API key).\n" +
    "  • Google API key (paste in Settings → Gryphon → Google API key)."
  );
}

/**
 * Environment-aware diagnostic for CLI-mode-but-binary-not-found. The
 * most common cause is a sandbox (Flatpak Obsidian) that can't see
 * system-installed binaries — saying "not found" in that case leaves
 * the user with no path forward. Detecting the sandbox and surfacing
 * the exact remediation commands is the cleanest thing we can do.
 */
function _cliNotFoundMessage() {
  const { detectFlatpakSandbox } = require("../utils");
  const { isFlatpak, appId } = detectFlatpakSandbox();
  if (isFlatpak) {
    return (
      "No local `claude` CLI found. Obsidian is running inside a Flatpak " +
      `sandbox (${appId}), which can't see binaries outside your home ` +
      "directory. Two ways to fix:\n\n" +
      "  (a) Install claude under $HOME:\n" +
      "        npm config set prefix ~/.npm-global\n" +
      "        npm install -g @anthropic-ai/claude-code\n" +
      "      Then restart Obsidian.\n\n" +
      "  (b) Grant Flatpak read access to /usr:\n" +
      `        flatpak override --user --filesystem=/usr:ro ${appId}\n` +
      "      Then restart Obsidian and set Settings → Gryphon → Claude CLI " +
      "path to /usr/bin/claude (or wherever your install landed).\n\n" +
      "(c) Or switch Provider to SDK and supply an Anthropic API key."
    );
  }
  return (
    "No local `claude` CLI found. Gryphon checked the common install " +
    "locations (/usr/bin, /usr/local/bin, ~/.local/bin, ~/.npm-global/bin, " +
    "/opt/homebrew/bin, /snap/bin, ...) and asked your login shell. " +
    "Install claude via your preferred method (npm, brew, apt), then " +
    "restart Obsidian. If it's already installed in a non-standard " +
    "location, set the full path in Settings → Gryphon → Claude CLI path. " +
    "Or switch Provider to SDK and supply an Anthropic API key."
  );
}

// Lazy-import findClaudeBinary so the factory module loads without
// pulling in fs/path machinery for SDK-only callers.
let _findClaudeBinary = null;
function _detectClaudeBinary() {
  if (!_findClaudeBinary) {
    _findClaudeBinary = require("../utils").findClaudeBinary;
  }
  return _findClaudeBinary();
}

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
function detectAvailable(plugin) {
  const settings = plugin.settings || {};
  const cliPath = settings.claudePath || _detectClaudeBinary() || null;
  let apiKey = "";
  let apiKeySource = null;
  if (settings.anthropicApiKey) {
    apiKey = settings.anthropicApiKey;
    apiKeySource = "settings";
  } else if (process.env.ANTHROPIC_API_KEY) {
    apiKey = process.env.ANTHROPIC_API_KEY;
    apiKeySource = "env";
  }

  let openaiKey = "";
  let openaiKeySource = null;
  if (settings.openaiApiKey) {
    openaiKey = settings.openaiApiKey;
    openaiKeySource = "settings";
  } else if (process.env.OPENAI_API_KEY) {
    openaiKey = process.env.OPENAI_API_KEY;
    openaiKeySource = "env";
  }

  let googleKey = "";
  let googleKeySource = null;
  if (settings.googleApiKey) {
    googleKey = settings.googleApiKey;
    googleKeySource = "settings";
  } else if (process.env.GOOGLE_API_KEY) {
    googleKey = process.env.GOOGLE_API_KEY;
    googleKeySource = "env";
  }

  return {
    cliPath,
    apiKey, apiKeySource,
    openaiKey, openaiKeySource,
    googleKey, googleKeySource,
  };
}

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
function getActiveProviderKind(plugin) {
  const settings = (plugin && plugin.settings) || {};
  const preference = settings.providerPreference || DEFAULT_PROVIDER_PREFERENCE;
  const claudePath = settings.claudePath || _detectClaudeBinary();
  const apiKey = settings.anthropicApiKey || process.env.ANTHROPIC_API_KEY || "";
  const openaiKey = settings.openaiApiKey || process.env.OPENAI_API_KEY || "";
  const googleKey = settings.googleApiKey || process.env.GOOGLE_API_KEY || "";

  if (preference === "claude-code")   return claudePath ? "claude-code"   : null;
  if (preference === "anthropic-api") return apiKey     ? "anthropic-api" : null;
  if (preference === "openai-api")    return openaiKey  ? "openai-api"    : null;
  if (preference === "google-api")    return googleKey  ? "google-api"    : null;

  // auto: same priority as createProvider's auto-fallthrough.
  if (claudePath) return "claude-code";
  if (apiKey)     return "anthropic-api";
  if (openaiKey)  return "openai-api";
  if (googleKey)  return "google-api";
  return null;
}

module.exports = { createProvider, explainUnavailable, detectAvailable, getActiveProviderKind };
