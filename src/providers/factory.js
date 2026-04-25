/**
 * Provider factory — selects an LLMProvider implementation based on
 * settings + runtime availability.
 *
 * Selection logic:
 *   providerPreference = "auto"          → claude-code if claudePath
 *                                           present, else anthropic-api
 *                                           if apiKey present, else null
 *                      = "claude-code"   → Claude Code CLI (or null if
 *                                           claudePath missing)
 *                      = "anthropic-api" → Anthropic API (or null if
 *                                           apiKey missing)
 *
 * Returning null from createProvider is a soft failure — the caller
 * (chat-view) is responsible for surfacing setup guidance to the user.
 *
 * The current "auto" tiebreaker prefers claude-code when both are
 * available. Rationale: subscription users get the CLI's per-prompt-
 * cached, no-extra-cost lane by default; the Anthropic API is the
 * policy-safe fallback that costs per-token. Users who want the
 * Anthropic API explicitly can switch in settings.
 */

const { ClaudeCodeProvider } = require("./claude-code/claude-code");
const { AnthropicAPIProvider } = require("./anthropic-api/anthropic-api");

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
  const preference = settings.providerPreference || "auto";
  const claudePath = settings.claudePath || _detectClaudeBinary();
  const apiKey = settings.anthropicApiKey || process.env.ANTHROPIC_API_KEY || "";

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

  // auto: claude-code wins if both are available (subscription path is
  // no extra cost per prompt).
  if (claudePath) return new ClaudeCodeProvider(claudePath, cwd, { ...options, plugin });
  if (apiKey)     return new AnthropicAPIProvider(apiKey, cwd, { ...options, plugin });
  return null;
}

/**
 * Returns a human-readable explanation of why createProvider returned
 * null, used by chat-view to surface a setup hint to the user.
 */
function explainUnavailable(plugin) {
  const settings = plugin.settings || {};
  const preference = settings.providerPreference || "anthropic-api";
  const hasCli = !!(settings.claudePath || _detectClaudeBinary());
  const hasKey = !!(settings.anthropicApiKey || process.env.ANTHROPIC_API_KEY);

  if (preference === "claude-code" && !hasCli) {
    return _cliNotFoundMessage();
  }
  if (preference === "anthropic-api" && !hasKey) {
    return "Anthropic API key not set. Paste a key in Settings → Gryphon → " +
           "Anthropic API key.";
  }
  // auto with neither
  return "No provider available. Paste an Anthropic API key in " +
         "Settings → Gryphon → Anthropic API key.";
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
  return { cliPath, apiKey, apiKeySource };
}

module.exports = { createProvider, explainUnavailable, detectAvailable };
