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

// Issue #26 / gryphon-dev#38: each API SDK pulls in significant transitive
// bytes:
//   - @anthropic-ai/sdk ~150 KB
//   - openai            ~163 KB
//   - @google/genai     ~625 KB
// A user on a single provider must not pay parse + module-init cost for the
// others. The provider classes are imported statically below because their
// modules no longer load an SDK at module load: each API provider imports
// its SDK on first use (one cached dynamic `import()` per provider module),
// so the SDK for a branch the user never takes is never evaluated.
import { DEFAULT_PROVIDER_PREFERENCE, pricing as configPricing, registry as configRegistry } from "@polleoai/gryphon-provider-config";
import { resolveCliPath as protectResolveCliPath, setActiveProviderKindResolver } from "@polleoai/gryphon-protect";
import * as utils from "./utils";
import { HeadlessHostAdapter } from "./host-adapter";
import { ClaudeCodeProvider } from "./providers/claude-code/claude-code";
import { AnthropicAPIProvider } from "./providers/anthropic-api/anthropic-api";
import { OpenAIProvider } from "./providers/openai-api/openai-api";
import { GoogleProvider } from "./providers/google-api/google-api";
import { CodexProvider } from "./providers/codex-cli/codex-cli";
import { GeminiCliProvider } from "./providers/gemini-cli/gemini-cli";
import { AntigravityCliProvider } from "./providers/antigravity-cli/antigravity-cli";
import type { LLMProvider, ProviderKind } from "./types";

/** The settings fields the factory reads (host settings carry many more). */
interface FactorySettings {
  providerPreference?: string;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  googleApiKey?: string;
  fallbackProviderPreference?: string;
  fallbackModel?: string;
}

/** The host plugin (Gryphon's, or an embedder's stub); passed through to providers. */
interface FactoryPlugin {
  settings?: FactorySettings | null;
  securityHostId?: string;
  app?: unknown;
}

/** Per-call options; everything beyond these is passed through to the provider. */
type FactoryOptions = {
  cliPaths?: Record<string, string | null | undefined> | null;
  securityHostId?: string;
  securityOverrides?: { paths?: unknown } | null;
  hostAdapter?: unknown;
  extraArgs?: unknown;
  extraArgsByProvider?: Record<string, string[] | undefined> | null;
  [key: string]: unknown;
};

/** Headless options-bag form of createProvider. */
interface ProviderBag {
  kind: string;
  config?: object | null;
  cwd?: string;
  options?: object | null;
  hostAdapter?: unknown;
}

/** Bag config + options merged (keys / CLI paths the bag path reads). */
type BagOptions = {
  apiKey?: string;
  claudePath?: string;
  codexPath?: string;
  geminiPath?: string;
  antigravityPath?: string;
  [key: string]: unknown;
};

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
 *   CLI binary paths are NEVER read from settings (issue #30): settings is
 *   the vault's data.json. They come from `options.cliPaths` (resolved by
 *   the chat view), else `resolveCliPath` (code override → this machine's
 *   store for `options.securityHostId ?? plugin.securityHostId` →
 *   detection).
 *
 * @returns {object|null}     — LLMProvider instance, or null if no
 *                              provider can be constructed (caller shows
 *                              setup guidance).
 */
function createProvider(pluginOrBag: FactoryPlugin | ProviderBag, cwd?: string, options: FactoryOptions = {}): LLMProvider | null {
  // Detect headless options-bag form: { kind, config, cwd?, options?, hostAdapter? }
  // Positive discriminant: real Obsidian plugin instances never have a `.kind`
  // string property, so this single check is unambiguous and removes the
  // previous `settings === undefined` footgun (a test stub like
  // `{ settings: undefined, ... }` would have routed into the bag path,
  // missed `.kind`, and silently returned null).
  if ("kind" in pluginOrBag && typeof pluginOrBag.kind === "string") {
    return _createProviderFromBag(pluginOrBag);
  }
  const plugin = pluginOrBag as FactoryPlugin;
  const settings: FactorySettings = plugin.settings || {};
  const preference = settings.providerPreference || DEFAULT_PROVIDER_PREFERENCE;

  // Resolve the user's preference to a concrete kind, then construct via the
  // shared per-kind table. "auto" resolves to the first available provider
  // (claude-code → anthropic → openai → google); the CLI fallthroughs
  // (codex-cli / gemini-cli) are NOT in the auto rotation — they have their
  // own sandbox/approval UX that surprises users who didn't explicitly opt
  // in, so selecting them must be intentional. An explicit kind whose
  // key/CLI is missing yields null from _buildProvider (the caller shows
  // setup guidance via explainUnavailable).
  const kind = preference === "auto" ? _firstAvailableKind(settings, _cliPathResolver(plugin, options)) : preference;
  if (!kind) return null;
  return _buildProvider(plugin, kind, cwd, options);
}

/**
 * Issue #30: where every factory reader gets a CLI binary path. A vault's
 * data.json is never consulted — a shared vault could otherwise point
 * `claudePath` at a script it ships and have the first chat (or even the
 * `--version` detection probe) run it.
 *
 *   options.cliPaths[kind]  — already resolved by the caller (the chat view);
 *   else resolveCliPath     — code override (options.securityOverrides.paths)
 *                             → this machine's store for the host id
 *                             → find*Binary detection.
 * Returns a per-call memoised `(kind) => path | null`.
 */
function _cliPathResolver(plugin: FactoryPlugin | null | undefined, options: FactoryOptions = {}): (kind: string) => string | null {
  const given = options && options.cliPaths && typeof options.cliPaths === "object" ? options.cliPaths : null;
  const memo: Record<string, string | null> = {};
  return (kind: string) => {
    if (given && Object.prototype.hasOwnProperty.call(given, kind)) return given[kind] || null;
    if (Object.prototype.hasOwnProperty.call(memo, kind)) return memo[kind];
    const hostId = options.securityHostId !== undefined ? options.securityHostId : plugin && plugin.securityHostId;
    const r = protectResolveCliPath(kind, {
      app: plugin && plugin.app,
      hostPlugin: plugin,
      // null and undefined both mean "no host id" to resolveCliPath.
      hostId: hostId ?? undefined,
      overrides: options.securityOverrides,
      detect: _detectFor,
    });
    return (memo[kind] = r.path || null);
  };
}

/** Detection through this module's own utils (patchable in tests). */
function _detectFor(kind: string): string | null {
  if (kind === "claude-code") return _detectClaudeBinary();
  if (kind === "codex-cli") return _detectCodexBinary();
  if (kind === "gemini-cli") return _detectGeminiBinary();
  if (kind === "antigravity-cli") return _detectAntigravityBinary();
  return null;
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
function createProviderForKind(
  plugin: FactoryPlugin | null | undefined, kind: ProviderKind, cwd?: string,
  options: FactoryOptions = {}, modelOverride?: string,
): LLMProvider | null {
  if (!plugin || typeof kind !== "string") return null;
  return _buildProvider(plugin, kind, cwd, options, modelOverride);
}

/**
 * Shared per-kind construction table — the single source of truth for how a
 * concrete provider kind maps to a constructor + the key/CLI it needs.
 * createProvider (after resolving its preference) and createProviderForKind
 * both route through here so the two can never drift.
 */
function _buildProvider(
  plugin: FactoryPlugin, kind: string, cwd?: string,
  options: FactoryOptions = {}, modelOverride?: string,
): LLMProvider | null {
  const settings: FactorySettings = plugin.settings || {};
  const pathFor = _cliPathResolver(plugin, options);
  const apiKey = settings.anthropicApiKey || process.env.ANTHROPIC_API_KEY || "";
  const openaiKey = settings.openaiApiKey || process.env.OPENAI_API_KEY || "";
  const googleKey = settings.googleApiKey || process.env.GOOGLE_API_KEY || "";

  // Issue #39: per-provider extraArgs targeting. `enrich(kind)` returns
  // options with extraArgs = legacy bucket + extraArgsByProvider[kind].
  // The merged array is run through the provider's cross-provider filter
  // (in claude-code.js / codex-cli.js / gemini-cli.js); both buckets are
  // equally subject to it. SDK providers ignore extraArgs entirely.
  // hostAdapter: callers may supply one via options (ObsidianHostAdapter in
  // Obsidian). If absent, default to HeadlessHostAdapter so the provider is
  // always adapter-safe regardless of host.
  const hostAdapter = options.hostAdapter || new HeadlessHostAdapter();
  const enrich = (k: string) => {
    const legacy: unknown[] = Array.isArray(options.extraArgs) ? options.extraArgs : [];
    const perKind = (options.extraArgsByProvider && options.extraArgsByProvider[k]) || [];
    const merged: Record<string, unknown> = {
      ...options,
      extraArgs: [...legacy, ...perKind],
      plugin,
      hostAdapter,
    };
    // Failover: build the fallback at its configured model without mutating
    // settings. Only override when explicitly provided so the active path
    // keeps options.model untouched.
    if (modelOverride) merged.model = modelOverride;
    return merged;
  };

  // claude-code provider receives `plugin` too, so it can read the active
  // protected-path / protected-command settings and translate them to Claude
  // Code's `--disallowedTools` flags on spawn.
  if (kind === "claude-code") {
    const claudePath = pathFor("claude-code");
    if (!claudePath) return null;
    return new ClaudeCodeProvider(claudePath, cwd, enrich("claude-code")) as LLMProvider;
  }
  if (kind === "anthropic-api") {
    if (!apiKey) return null;
    return new AnthropicAPIProvider(apiKey, cwd as string, enrich("anthropic-api")) as LLMProvider;
  }
  if (kind === "openai-api") {
    if (!openaiKey) return null;
    return new OpenAIProvider(openaiKey, cwd as string, enrich("openai-api")) as LLMProvider;
  }
  if (kind === "google-api") {
    if (!googleKey) return null;
    return new GoogleProvider(googleKey, cwd as string, enrich("google-api")) as LLMProvider;
  }
  // codex-cli (v1.3): the OpenAI Codex CLI subprocess. Auth is handled by the
  // CLI itself (`codex login`); no API key from settings. Binary must exist.
  if (kind === "codex-cli") {
    const codexPath = pathFor("codex-cli");
    if (!codexPath) return null;
    return new CodexProvider(codexPath, cwd, enrich("codex-cli")) as LLMProvider;
  }
  // gemini-cli (v1.3): the Google Gemini CLI subprocess. Auth via
  // settings.googleApiKey forwarded as GEMINI_API_KEY env. Binary must exist.
  if (kind === "gemini-cli") {
    const geminiPath = pathFor("gemini-cli");
    if (!geminiPath) return null;
    return new GeminiCliProvider(geminiPath, cwd, enrich("gemini-cli")) as LLMProvider;
  }
  // antigravity-cli (issue #19): the Google Antigravity CLI (`agy`)
  // subprocess. Auth is handled by the CLI itself (silent keyring / OAuth,
  // mirrors codex-cli's `codex login` model); no API key from settings.
  // Binary must exist.
  if (kind === "antigravity-cli") {
    const antigravityPath = pathFor("antigravity-cli");
    if (!antigravityPath) return null;
    return new AntigravityCliProvider(antigravityPath, cwd, enrich("antigravity-cli")) as LLMProvider;
  }
  return null;
}

/**
 * First available provider kind in the auto-rotation order
 * (claude-code → anthropic-api → openai-api → google-api), or null. Used by
 * createProvider's "auto" path and resolveFallback's "auto" fallback. The
 * CLI fallthroughs are intentionally excluded (see createProvider).
 */
function _firstAvailableKind(settings: FactorySettings, pathFor: (kind: string) => string | null): ProviderKind | null {
  const claudePath = pathFor("claude-code");
  const apiKey = settings.anthropicApiKey || process.env.ANTHROPIC_API_KEY || "";
  const openaiKey = settings.openaiApiKey || process.env.OPENAI_API_KEY || "";
  const googleKey = settings.googleApiKey || process.env.GOOGLE_API_KEY || "";
  if (claudePath) return "claude-code";
  if (apiKey) return "anthropic-api";
  if (openaiKey) return "openai-api";
  if (googleKey) return "google-api";
  return null;
}

/**
 * The registry default model id for a provider kind's vendor. Used by
 * resolveFallback when `settings.fallbackModel` is unset.
 */
function defaultModelForKind(kind: string): string {
  // CLI kinds that serve only a subset of their vendor's models have their
  // own default — the vendor default (gpt-6.1-sol) is rejected by Codex's
  // ChatGPT auth, and agy has its own catalog.
  try {
    const pricing = configPricing;
    if (kind === "codex-cli") return pricing.openai.CODEX_CLI_DEFAULT_MODEL;
    // Typed loosely upstream; it is the agy default model id.
    if (kind === "antigravity-cli") return pricing.google.ANTIGRAVITY_CLI_DEFAULT_MODEL;
  } catch { /* fall through to the vendor default */ }
  const vendor =
    (kind === "anthropic-api" || kind === "claude-code") ? "anthropic" :
    (kind === "openai-api" || kind === "codex-cli") ? "openai" :
    // antigravity-cli is the Gemini-based Antigravity suite (issue #19) —
    // shares the google vendor default with gemini-cli/google-api.
    (kind === "google-api" || kind === "gemini-cli" || kind === "antigravity-cli") ? "google" : null;
  if (!vendor) return "";
  try {
    return configRegistry.defaultModelFor(vendor) || "";
  } catch { return ""; }
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
function resolveFallback(plugin: FactoryPlugin | null | undefined, options: FactoryOptions = {}): { kind: ProviderKind; model: string } | null {
  const settings: FactorySettings = (plugin && plugin.settings) || {};
  const pref = settings.fallbackProviderPreference;
  if (pref === "none") return null;

  const pathFor = _cliPathResolver(plugin, options);
  let kind: ProviderKind | null;
  if (!pref) {
    kind = pathFor("claude-code") ? "claude-code" : null;
  } else if (pref === "auto") {
    kind = _firstAvailableKind(settings, pathFor);
  } else {
    kind = pref as ProviderKind; // an explicit user choice is taken at face value
  }
  if (!kind) return null;
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
function _createProviderFromBag(bag: ProviderBag): LLMProvider | null {
  const kind = bag.kind;
  const config = bag.config || {};
  const cwd = bag.cwd || "";
  const baseOptions = bag.options || {};
  const hostAdapter = bag.hostAdapter || new HeadlessHostAdapter();
  const opts: BagOptions = { ...config, ...baseOptions, hostAdapter };

  if (kind === "anthropic-api") {
    if (!opts.apiKey) return null;
    return new AnthropicAPIProvider(opts.apiKey, cwd, opts) as LLMProvider;
  }
  if (kind === "openai-api") {
    if (!opts.apiKey) return null;
    return new OpenAIProvider(opts.apiKey, cwd, opts) as LLMProvider;
  }
  if (kind === "google-api") {
    if (!opts.apiKey) return null;
    return new GoogleProvider(opts.apiKey, cwd, opts) as LLMProvider;
  }
  if (kind === "claude-code") {
    const claudePath = opts.claudePath || _detectClaudeBinary();
    if (!claudePath) return null;
    return new ClaudeCodeProvider(claudePath, cwd, opts as ConstructorParameters<typeof ClaudeCodeProvider>[2]) as LLMProvider;
  }
  if (kind === "codex-cli") {
    const codexPath = opts.codexPath || _detectCodexBinary();
    if (!codexPath) return null;
    return new CodexProvider(codexPath, cwd, opts) as LLMProvider;
  }
  if (kind === "gemini-cli") {
    const geminiPath = opts.geminiPath || _detectGeminiBinary();
    if (!geminiPath) return null;
    return new GeminiCliProvider(geminiPath, cwd, opts) as LLMProvider;
  }
  if (kind === "antigravity-cli") {
    const antigravityPath = opts.antigravityPath || _detectAntigravityBinary();
    if (!antigravityPath) return null;
    return new AntigravityCliProvider(antigravityPath, cwd, opts) as LLMProvider;
  }
  return null;
}

/**
 * Returns a human-readable explanation of why createProvider returned
 * null, used by chat-view to surface a setup hint to the user.
 */
function explainUnavailable(plugin: FactoryPlugin, options: FactoryOptions = {}): string {
  const settings: FactorySettings = plugin.settings || {};
  const pathFor = _cliPathResolver(plugin, options);
  // Round 15 fix (F20): single source of truth for the default. Previously
  // createProvider used "auto" while explainUnavailable used "anthropic-api"
  // — those two assumptions diverged in the settings-corruption /
  // pre-DEFAULT-merge edge case.
  const preference = settings.providerPreference || DEFAULT_PROVIDER_PREFERENCE;
  const hasCli = !!pathFor("claude-code");
  const hasKey = !!(settings.anthropicApiKey || process.env.ANTHROPIC_API_KEY);
  const hasOpenAiKey = !!(settings.openaiApiKey || process.env.OPENAI_API_KEY);
  const hasGoogleKey = !!(settings.googleApiKey || process.env.GOOGLE_API_KEY);
  const hasCodexCli = !!pathFor("codex-cli");
  const hasGeminiCli = !!pathFor("gemini-cli");
  const hasAntigravityCli = !!pathFor("antigravity-cli");

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
      return (
        "No local `codex` CLI found. Install Codex from " +
        "https://chatgpt.com/codex (macOS app installs the CLI at " +
        "/Applications/Codex.app/Contents/Resources/codex), or set " +
        "the full path in Settings → Gryphon → Codex CLI path. After " +
        "installing, run `codex login` in a terminal once. Or switch " +
        "Provider to OpenAI API and supply an API key."
      );
    }
    return "Codex CLI failed to initialize. Verify the binary path in Settings.";
  }
  if (preference === "gemini-cli") {
    if (!hasGeminiCli) {
      return (
        "No local `gemini` CLI found. Install via `npm install -g " +
        "@google/gemini-cli` (or your preferred package manager), or " +
        "set the full path in Settings → Gryphon → Gemini CLI path. " +
        "Or switch Provider to Google Gemini API and supply an API key."
      );
    }
    return "Gemini CLI failed to initialize. Verify the binary path in Settings.";
  }
  if (preference === "antigravity-cli") {
    if (!hasAntigravityCli) {
      return (
        "No local `agy` (Antigravity) CLI found. Install it with " +
        (process.platform === "win32"
          ? "`irm https://antigravity.google/cli/install.ps1 | iex` (PowerShell), or "
          : "`curl -fsSL https://antigravity.google/cli/install.sh | bash`, or ") +
        "set the full path in Settings → Gryphon → Antigravity CLI path. " +
        "After installing, run `agy` once in a terminal to authenticate. " +
        "Note: gemini-cli is deprecated for Gemini Code Assist individuals — " +
        "this is its replacement."
      );
    }
    return "Antigravity CLI failed to initialize. Verify the binary path in Settings.";
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
  const { isFlatpak, appId } = utils.detectFlatpakSandbox();
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

// The utils finders dispatch through utils.binaryFinders on every call, so a
// test that substitutes a finder there takes effect here too. (The lookup
// result itself is cached inside utils.)
function _detectClaudeBinary() {
  return utils.findClaudeBinary();
}

function _detectCodexBinary() {
  return utils.findCodexBinary();
}

function _detectGeminiBinary() {
  return utils.findGeminiBinary();
}

function _detectAntigravityBinary() {
  return utils.findAntigravityBinary();
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
function detectAvailable(plugin: FactoryPlugin, options: FactoryOptions = {}) {
  const settings: FactorySettings = plugin.settings || {};
  const pathFor = _cliPathResolver(plugin, options);
  const cliPath = pathFor("claude-code");
  let apiKey = "";
  let apiKeySource: "settings" | "env" | null = null;
  if (settings.anthropicApiKey) {
    apiKey = settings.anthropicApiKey;
    apiKeySource = "settings";
  } else if (process.env.ANTHROPIC_API_KEY) {
    apiKey = process.env.ANTHROPIC_API_KEY;
    apiKeySource = "env";
  }

  let openaiKey = "";
  let openaiKeySource: "settings" | "env" | null = null;
  if (settings.openaiApiKey) {
    openaiKey = settings.openaiApiKey;
    openaiKeySource = "settings";
  } else if (process.env.OPENAI_API_KEY) {
    openaiKey = process.env.OPENAI_API_KEY;
    openaiKeySource = "env";
  }

  let googleKey = "";
  let googleKeySource: "settings" | "env" | null = null;
  if (settings.googleApiKey) {
    googleKey = settings.googleApiKey;
    googleKeySource = "settings";
  } else if (process.env.GOOGLE_API_KEY) {
    googleKey = process.env.GOOGLE_API_KEY;
    googleKeySource = "env";
  }

  const codexPath = pathFor("codex-cli");
  const geminiCliPath = pathFor("gemini-cli");
  const antigravityPath = pathFor("antigravity-cli");

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
function getActiveProviderKind(plugin: FactoryPlugin | null | undefined, options: FactoryOptions = {}): ProviderKind | null {
  const settings: FactorySettings = (plugin && plugin.settings) || {};
  const preference = settings.providerPreference || DEFAULT_PROVIDER_PREFERENCE;
  // Lazy: only the kind the preference names is resolved (each resolve may
  // probe `--version` on a validated binary).
  const pathFor = _cliPathResolver(plugin, options);
  const apiKey = settings.anthropicApiKey || process.env.ANTHROPIC_API_KEY || "";
  const openaiKey = settings.openaiApiKey || process.env.OPENAI_API_KEY || "";
  const googleKey = settings.googleApiKey || process.env.GOOGLE_API_KEY || "";

  if (preference === "claude-code")     return pathFor("claude-code")     ? "claude-code"     : null;
  if (preference === "anthropic-api")   return apiKey                     ? "anthropic-api"   : null;
  if (preference === "openai-api")      return openaiKey                  ? "openai-api"      : null;
  if (preference === "google-api")      return googleKey                  ? "google-api"      : null;
  if (preference === "codex-cli")       return pathFor("codex-cli")       ? "codex-cli"       : null;
  if (preference === "gemini-cli")      return pathFor("gemini-cli")      ? "gemini-cli"      : null;
  if (preference === "antigravity-cli") return pathFor("antigravity-cli") ? "antigravity-cli" : null;

  // auto: same priority as createProvider's auto-fallthrough — CLI
  // fallthroughs are NOT in this list (see createProvider for rationale).
  if (pathFor("claude-code")) return "claude-code";
  if (apiKey)     return "anthropic-api";
  if (openaiKey)  return "openai-api";
  if (googleKey)  return "google-api";
  return null;
}

// protect's permission prompt names the active assistant ("Codex is asking …")
// but can't import this module (factory → providers → protect would cycle), so
// the factory registers the lookup when it loads.
setActiveProviderKindResolver((plugin) => getActiveProviderKind(plugin as FactoryPlugin | null | undefined));

export {
  createProvider, explainUnavailable, detectAvailable, getActiveProviderKind,
  // Issue #15 failover kernel
  createProviderForKind, resolveFallback, defaultModelForKind,
};
