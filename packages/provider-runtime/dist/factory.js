"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.createProvider = createProvider;
exports.explainUnavailable = explainUnavailable;
exports.detectAvailable = detectAvailable;
exports.getActiveProviderKind = getActiveProviderKind;
exports.createProviderForKind = createProviderForKind;
exports.resolveFallback = resolveFallback;
exports.defaultModelForKind = defaultModelForKind;
// Issue #26: provider classes are lazy-required inside each branch of
// `createProvider` rather than at module load. Each SDK pulls in
// significant transitive bytes:
//   - @anthropic-ai/sdk ~150 KB
//   - openai            ~163 KB
//   - @google/genai     ~625 KB
// A user on a single provider used to pay parse + side-effect cost for
// the other two. esbuild bundles all of them either way (no DCE), but
// Node defers `_compile` until `require()` actually runs — so deferring
// the require defers the V8 parse + module-init work for branches the
// user never takes. claude-code / codex-cli / gemini-cli are subprocess-
// based and have no heavy SDK, but lazy-requiring them too keeps the
// pattern symmetric and makes future SDK additions impossible to forget.
const { DEFAULT_PROVIDER_PREFERENCE } = require("@gryphon/provider-config");
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
function createProvider(pluginOrBag, cwd, options = {}) {
    // Detect headless options-bag form: { kind, config, cwd?, options?, hostAdapter? }
    // Positive discriminant: real Obsidian plugin instances never have a `.kind`
    // string property, so this single check is unambiguous and removes the
    // previous `settings === undefined` footgun (a test stub like
    // `{ settings: undefined, ... }` would have routed into the bag path,
    // missed `.kind`, and silently returned null).
    if (typeof pluginOrBag.kind === "string") {
        return _createProviderFromBag(pluginOrBag);
    }
    const plugin = pluginOrBag;
    const settings = plugin.settings || {};
    const preference = settings.providerPreference || DEFAULT_PROVIDER_PREFERENCE;
    // Resolve the user's preference to a concrete kind, then construct via the
    // shared per-kind table. "auto" resolves to the first available provider
    // (claude-code → anthropic → openai → google); the CLI fallthroughs
    // (codex-cli / gemini-cli) are NOT in the auto rotation — they have their
    // own sandbox/approval UX that surprises users who didn't explicitly opt
    // in, so selecting them must be intentional. An explicit kind whose
    // key/CLI is missing yields null from _buildProvider (the caller shows
    // setup guidance via explainUnavailable).
    const kind = preference === "auto" ? _firstAvailableKind(settings) : preference;
    if (!kind)
        return null;
    return _buildProvider(plugin, kind, cwd, options);
}
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
function createProviderForKind(plugin, kind, cwd, options = {}, modelOverride) {
    if (!plugin || typeof kind !== "string")
        return null;
    return _buildProvider(plugin, kind, cwd, options, modelOverride);
}
/**
 * Shared per-kind construction table — the single source of truth for how a
 * concrete provider kind maps to a constructor + the key/CLI it needs.
 * createProvider (after resolving its preference) and createProviderForKind
 * both route through here so the two can never drift.
 */
function _buildProvider(plugin, kind, cwd, options = {}, modelOverride) {
    const settings = plugin.settings || {};
    const claudePath = settings.claudePath || _detectClaudeBinary();
    const apiKey = settings.anthropicApiKey || process.env.ANTHROPIC_API_KEY || "";
    const openaiKey = settings.openaiApiKey || process.env.OPENAI_API_KEY || "";
    const googleKey = settings.googleApiKey || process.env.GOOGLE_API_KEY || "";
    const codexPath = settings.codexPath || _detectCodexBinary();
    const geminiPath = settings.geminiCliPath || _detectGeminiBinary();
    const antigravityPath = settings.antigravityPath || _detectAntigravityBinary();
    // Issue #39: per-provider extraArgs targeting. `enrich(kind)` returns
    // options with extraArgs = legacy bucket + extraArgsByProvider[kind].
    // The merged array is run through the provider's cross-provider filter
    // (in claude-code.js / codex-cli.js / gemini-cli.js); both buckets are
    // equally subject to it. SDK providers ignore extraArgs entirely.
    // hostAdapter: callers may supply one via options (ObsidianHostAdapter in
    // Obsidian). If absent, default to HeadlessHostAdapter so the provider is
    // always adapter-safe regardless of host.
    const hostAdapter = options.hostAdapter || new (require("./host-adapter").HeadlessHostAdapter)();
    const enrich = (k) => {
        const legacy = Array.isArray(options.extraArgs) ? options.extraArgs : [];
        const perKind = (options.extraArgsByProvider && options.extraArgsByProvider[k]) || [];
        const merged = {
            ...options,
            extraArgs: [...legacy, ...perKind],
            plugin,
            hostAdapter,
        };
        // Failover: build the fallback at its configured model without mutating
        // settings. Only override when explicitly provided so the active path
        // keeps options.model untouched.
        if (modelOverride)
            merged.model = modelOverride;
        return merged;
    };
    // claude-code provider receives `plugin` too, so it can read the active
    // protected-path / protected-command settings and translate them to Claude
    // Code's `--disallowedTools` flags on spawn.
    if (kind === "claude-code") {
        if (!claudePath)
            return null;
        const { ClaudeCodeProvider } = require("./providers/claude-code/claude-code");
        return new ClaudeCodeProvider(claudePath, cwd, enrich("claude-code"));
    }
    if (kind === "anthropic-api") {
        if (!apiKey)
            return null;
        const { AnthropicAPIProvider } = require("./providers/anthropic-api/anthropic-api");
        return new AnthropicAPIProvider(apiKey, cwd, enrich("anthropic-api"));
    }
    if (kind === "openai-api") {
        if (!openaiKey)
            return null;
        const { OpenAIProvider } = require("./providers/openai-api/openai-api");
        return new OpenAIProvider(openaiKey, cwd, enrich("openai-api"));
    }
    if (kind === "google-api") {
        if (!googleKey)
            return null;
        const { GoogleProvider } = require("./providers/google-api/google-api");
        return new GoogleProvider(googleKey, cwd, enrich("google-api"));
    }
    // codex-cli (v1.3): the OpenAI Codex CLI subprocess. Auth is handled by the
    // CLI itself (`codex login`); no API key from settings. Binary must exist.
    if (kind === "codex-cli") {
        if (!codexPath)
            return null;
        const { CodexProvider } = require("./providers/codex-cli/codex-cli");
        return new CodexProvider(codexPath, cwd, enrich("codex-cli"));
    }
    // gemini-cli (v1.3): the Google Gemini CLI subprocess. Auth via
    // settings.googleApiKey forwarded as GEMINI_API_KEY env. Binary must exist.
    if (kind === "gemini-cli") {
        if (!geminiPath)
            return null;
        const { GeminiCliProvider } = require("./providers/gemini-cli/gemini-cli");
        return new GeminiCliProvider(geminiPath, cwd, enrich("gemini-cli"));
    }
    // antigravity-cli (issue #19): the Google Antigravity CLI (`agy`)
    // subprocess. Auth is handled by the CLI itself (silent keyring / OAuth,
    // mirrors codex-cli's `codex login` model); no API key from settings.
    // Binary must exist.
    if (kind === "antigravity-cli") {
        if (!antigravityPath)
            return null;
        const { AntigravityCliProvider } = require("./providers/antigravity-cli/antigravity-cli");
        return new AntigravityCliProvider(antigravityPath, cwd, enrich("antigravity-cli"));
    }
    return null;
}
/**
 * First available provider kind in the auto-rotation order
 * (claude-code → anthropic-api → openai-api → google-api), or null. Used by
 * createProvider's "auto" path and resolveFallback's "auto" fallback. The
 * CLI fallthroughs are intentionally excluded (see createProvider).
 */
function _firstAvailableKind(settings) {
    const claudePath = settings.claudePath || _detectClaudeBinary();
    const apiKey = settings.anthropicApiKey || process.env.ANTHROPIC_API_KEY || "";
    const openaiKey = settings.openaiApiKey || process.env.OPENAI_API_KEY || "";
    const googleKey = settings.googleApiKey || process.env.GOOGLE_API_KEY || "";
    if (claudePath)
        return "claude-code";
    if (apiKey)
        return "anthropic-api";
    if (openaiKey)
        return "openai-api";
    if (googleKey)
        return "google-api";
    return null;
}
/**
 * The registry default model id for a provider kind's vendor. Used by
 * resolveFallback when `settings.fallbackModel` is unset.
 */
function defaultModelForKind(kind) {
    const vendor = (kind === "anthropic-api" || kind === "claude-code") ? "anthropic" :
        (kind === "openai-api" || kind === "codex-cli") ? "openai" :
            // antigravity-cli is the Gemini-based Antigravity suite (issue #19) —
            // shares the google vendor default with gemini-cli/google-api.
            (kind === "google-api" || kind === "gemini-cli" || kind === "antigravity-cli") ? "google" : null;
    if (!vendor)
        return "";
    try {
        return require("@gryphon/provider-config").registry.defaultModelFor(vendor) || "";
    }
    catch (_) {
        return "";
    }
}
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
function resolveFallback(plugin) {
    const settings = (plugin && plugin.settings) || {};
    const pref = settings.fallbackProviderPreference;
    if (pref === "none")
        return null;
    let kind;
    if (!pref) {
        const claudePath = settings.claudePath || _detectClaudeBinary();
        kind = claudePath ? "claude-code" : null;
    }
    else if (pref === "auto") {
        kind = _firstAvailableKind(settings);
    }
    else {
        kind = pref;
    }
    if (!kind)
        return null;
    const model = settings.fallbackModel || defaultModelForKind(kind);
    return { kind, model };
}
/**
 * Headless options-bag path for createProvider.
 * Accepts { kind, config, cwd?, options?, hostAdapter? }.
 * `kind` must be one of the six provider IDs.
 * `config` is passed as options to the concrete constructor.
 * `hostAdapter` defaults to HeadlessHostAdapter when absent.
 */
function _createProviderFromBag(bag) {
    const kind = bag.kind;
    const config = bag.config || {};
    const cwd = bag.cwd || "";
    const baseOptions = bag.options || {};
    const { HeadlessHostAdapter } = require("./host-adapter");
    const hostAdapter = bag.hostAdapter || new HeadlessHostAdapter();
    const opts = { ...config, ...baseOptions, hostAdapter };
    if (kind === "anthropic-api") {
        if (!opts.apiKey)
            return null;
        const { AnthropicAPIProvider } = require("./providers/anthropic-api/anthropic-api");
        return new AnthropicAPIProvider(opts.apiKey, cwd, opts);
    }
    if (kind === "openai-api") {
        if (!opts.apiKey)
            return null;
        const { OpenAIProvider } = require("./providers/openai-api/openai-api");
        return new OpenAIProvider(opts.apiKey, cwd, opts);
    }
    if (kind === "google-api") {
        if (!opts.apiKey)
            return null;
        const { GoogleProvider } = require("./providers/google-api/google-api");
        return new GoogleProvider(opts.apiKey, cwd, opts);
    }
    if (kind === "claude-code") {
        const claudePath = opts.claudePath || _detectClaudeBinary();
        if (!claudePath)
            return null;
        const { ClaudeCodeProvider } = require("./providers/claude-code/claude-code");
        return new ClaudeCodeProvider(claudePath, cwd, opts);
    }
    if (kind === "codex-cli") {
        const codexPath = opts.codexPath || _detectCodexBinary();
        if (!codexPath)
            return null;
        const { CodexProvider } = require("./providers/codex-cli/codex-cli");
        return new CodexProvider(codexPath, cwd, opts);
    }
    if (kind === "gemini-cli") {
        const geminiPath = opts.geminiPath || _detectGeminiBinary();
        if (!geminiPath)
            return null;
        const { GeminiCliProvider } = require("./providers/gemini-cli/gemini-cli");
        return new GeminiCliProvider(geminiPath, cwd, opts);
    }
    if (kind === "antigravity-cli") {
        const antigravityPath = opts.antigravityPath || _detectAntigravityBinary();
        if (!antigravityPath)
            return null;
        const { AntigravityCliProvider } = require("./providers/antigravity-cli/antigravity-cli");
        return new AntigravityCliProvider(antigravityPath, cwd, opts);
    }
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
    const hasCodexCli = !!(settings.codexPath || _detectCodexBinary());
    const hasGeminiCli = !!(settings.geminiCliPath || _detectGeminiBinary());
    const hasAntigravityCli = !!(settings.antigravityPath || _detectAntigravityBinary());
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
    if (preference === "codex-cli") {
        if (!hasCodexCli) {
            return ("No local `codex` CLI found. Install Codex from " +
                "https://chatgpt.com/codex (macOS app installs the CLI at " +
                "/Applications/Codex.app/Contents/Resources/codex), or set " +
                "the full path in Settings → Gryphon → Codex CLI path. After " +
                "installing, run `codex login` in a terminal once. Or switch " +
                "Provider to OpenAI API and supply an API key.");
        }
        return "Codex CLI failed to initialize. Verify the binary path in Settings.";
    }
    if (preference === "gemini-cli") {
        if (!hasGeminiCli) {
            return ("No local `gemini` CLI found. Install via `npm install -g " +
                "@google/gemini-cli` (or your preferred package manager), or " +
                "set the full path in Settings → Gryphon → Gemini CLI path. " +
                "Or switch Provider to Google Gemini API and supply an API key.");
        }
        return "Gemini CLI failed to initialize. Verify the binary path in Settings.";
    }
    if (preference === "antigravity-cli") {
        if (!hasAntigravityCli) {
            return ("No local `agy` (Antigravity) CLI found. Install it with " +
                "`curl -fsSL https://antigravity.google/cli/install.sh | bash`, or " +
                "set the full path in Settings → Gryphon → Antigravity CLI path. " +
                "After installing, run `agy` once in a terminal to authenticate. " +
                "Note: gemini-cli is deprecated for Gemini Code Assist individuals — " +
                "this is its replacement.");
        }
        return "Antigravity CLI failed to initialize. Verify the binary path in Settings.";
    }
    // auto-fallthrough with NO key/CLI at all. All three SDK adapters now
    // shipped — claude-code preserved as preferred when CLI is detected.
    return ("No provider available. Set up any of:\n" +
        "  • Claude Code CLI (install `claude`, then choose Claude Code in " +
        "Settings → Gryphon → Provider).\n" +
        "  • Anthropic API key (paste in Settings → Gryphon → Anthropic " +
        "API key — recommended).\n" +
        "  • OpenAI API key (paste in Settings → Gryphon → OpenAI API key).\n" +
        "  • Google API key (paste in Settings → Gryphon → Google API key).");
}
/**
 * Environment-aware diagnostic for CLI-mode-but-binary-not-found. The
 * most common cause is a sandbox (Flatpak Obsidian) that can't see
 * system-installed binaries — saying "not found" in that case leaves
 * the user with no path forward. Detecting the sandbox and surfacing
 * the exact remediation commands is the cleanest thing we can do.
 */
function _cliNotFoundMessage() {
    const { detectFlatpakSandbox } = require("./utils");
    const { isFlatpak, appId } = detectFlatpakSandbox();
    if (isFlatpak) {
        return ("No local `claude` CLI found. Obsidian is running inside a Flatpak " +
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
            "(c) Or switch Provider to SDK and supply an Anthropic API key.");
    }
    return ("No local `claude` CLI found. Gryphon checked the common install " +
        "locations (/usr/bin, /usr/local/bin, ~/.local/bin, ~/.npm-global/bin, " +
        "/opt/homebrew/bin, /snap/bin, ...) and asked your login shell. " +
        "Install claude via your preferred method (npm, brew, apt), then " +
        "restart Obsidian. If it's already installed in a non-standard " +
        "location, set the full path in Settings → Gryphon → Claude CLI path. " +
        "Or switch Provider to SDK and supply an Anthropic API key.");
}
// Look this up fresh on every call (like _detectCodexBinary /
// _detectGeminiBinary below) rather than caching the function reference:
// node's `require` already caches the module, the per-call cost is one
// property access, and the freshness lets tests patch `utils.findClaudeBinary`
// at runtime without invalidating a private factory cache. (The result of
// the lookup itself is cached inside utils.findClaudeBinary.)
function _detectClaudeBinary() {
    return require("./utils").findClaudeBinary();
}
// Look these up fresh on every call rather than caching the function
// reference at module scope — node's `require` itself caches the
// module, and the freshness lets tests patch `utils.findCodexBinary`
// at runtime without also having to invalidate a private factory
// cache. The lookup cost is one property access on a cached module.
function _detectCodexBinary() {
    return require("./utils").findCodexBinary();
}
function _detectGeminiBinary() {
    return require("./utils").findGeminiBinary();
}
function _detectAntigravityBinary() {
    return require("./utils").findAntigravityBinary();
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
    }
    else if (process.env.ANTHROPIC_API_KEY) {
        apiKey = process.env.ANTHROPIC_API_KEY;
        apiKeySource = "env";
    }
    let openaiKey = "";
    let openaiKeySource = null;
    if (settings.openaiApiKey) {
        openaiKey = settings.openaiApiKey;
        openaiKeySource = "settings";
    }
    else if (process.env.OPENAI_API_KEY) {
        openaiKey = process.env.OPENAI_API_KEY;
        openaiKeySource = "env";
    }
    let googleKey = "";
    let googleKeySource = null;
    if (settings.googleApiKey) {
        googleKey = settings.googleApiKey;
        googleKeySource = "settings";
    }
    else if (process.env.GOOGLE_API_KEY) {
        googleKey = process.env.GOOGLE_API_KEY;
        googleKeySource = "env";
    }
    const codexPath = settings.codexPath || _detectCodexBinary() || null;
    const geminiCliPath = settings.geminiCliPath || _detectGeminiBinary() || null;
    const antigravityPath = settings.antigravityPath || _detectAntigravityBinary() || null;
    return {
        cliPath,
        apiKey, apiKeySource,
        openaiKey, openaiKeySource,
        googleKey, googleKeySource,
        codexPath,
        geminiCliPath,
        antigravityPath,
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
    const codexPath = settings.codexPath || _detectCodexBinary();
    const geminiPath = settings.geminiCliPath || _detectGeminiBinary();
    const antigravityPath = settings.antigravityPath || _detectAntigravityBinary();
    if (preference === "claude-code")
        return claudePath ? "claude-code" : null;
    if (preference === "anthropic-api")
        return apiKey ? "anthropic-api" : null;
    if (preference === "openai-api")
        return openaiKey ? "openai-api" : null;
    if (preference === "google-api")
        return googleKey ? "google-api" : null;
    if (preference === "codex-cli")
        return codexPath ? "codex-cli" : null;
    if (preference === "gemini-cli")
        return geminiPath ? "gemini-cli" : null;
    if (preference === "antigravity-cli")
        return antigravityPath ? "antigravity-cli" : null;
    // auto: same priority as createProvider's auto-fallthrough — CLI
    // fallthroughs are NOT in this list (see createProvider for rationale).
    if (claudePath)
        return "claude-code";
    if (apiKey)
        return "anthropic-api";
    if (openaiKey)
        return "openai-api";
    if (googleKey)
        return "google-api";
    return null;
}
