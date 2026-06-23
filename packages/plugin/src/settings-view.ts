/**
 * settings-view.ts — Gryphon's portable settings renderer.
 *
 * `renderGryphonSettings(hostPlugin, containerEl, options?)` draws the
 * *portable config zone* — the Provider section (provider dropdown, CLI
 * paths, Anthropic/OpenAI/Google API keys, Brave key, the SDK toggles,
 * Block-REST toggle, connection timeout) and the Defaults section
 * (provider-aware Default model + effort, permissions, open-in-main-tab,
 * max file size). This is exactly the set of fields the provider runtime
 * consumes, and nothing that depends on plugin-only internals.
 *
 * Why a shared function (issue #14): consumers that embed Gryphon's chat
 * previously hand-mirrored every `new Setting(...)` row
 * and drifted — most visibly dropping the API-key inputs so API-key
 * providers were unconfigurable from the host. A single host-agnostic
 * renderer makes that drift structurally impossible: add a field here and
 * every consumer gets it for free.
 *
 * Host contract (the 2.4.x guarding rule): `hostPlugin` need only satisfy
 * `{ settings, saveSettings }`. Every Gryphon-internal touch
 * (`_resetActiveSessions`, `_announceProviderChange`, the
 * `gryphon:settings-changed` workspace trigger, `app`) is optional-chained
 * so a minimal host never crashes. The standalone plugin is itself a valid
 * host, so standalone Gryphon behaves and looks exactly as before.
 *
 * The Gryphon-plugin-only zone (Security / Protected-Mode / provenance /
 * diagnostics) stays in `GryphonSettingTab` — it depends on `provenanceStore`,
 * `@gryphon/protect`, and REST internals a generic host does not have.
 */

const { Setting, Notice } = require("obsidian");
const { MODELS, EFFORTS, PERMS, PROVIDER_PREFS, FALLBACK_PROVIDER_PREFS, resolveConnectionTimeoutMs } = require("./constants");
const { testApiKey: testAnthropicApiKey } = require("../../provider-runtime/src/providers/anthropic-api/anthropic-api");
const { testApiKey: testOpenAIApiKey } = require("../../provider-runtime/src/providers/openai-api/openai-api");
const { testApiKey: testGoogleApiKey } = require("../../provider-runtime/src/providers/google-api/test-key");

/**
 * Pick a sensible default model id for the active provider when the
 * persisted settings.model is not recognized by that provider's model
 * list. Used on Provider switch (in the dropdown's onChange) so the
 * chat-view toolbar + Settings dropdown stay in lockstep without showing
 * a stale cross-vendor id (e.g. "gpt-5.4-mini" lingering after switching
 * to Claude Code).
 *
 * Returns the new model id (or the unchanged current id when it's already
 * valid for the active provider). Caller is responsible for persisting.
 */
function _resetModelForProvider(plugin) {
  const { getActiveProviderKind } = require("@gryphon/provider-runtime");
  const settings = plugin.settings || {};
  const current = settings.model;
  const kind = getActiveProviderKind(plugin) || settings.providerPreference;

  if (kind === "openai-api" || kind === "codex-cli") {
    // codex-cli's ChatGPT-account auth supports a smaller subset
    // (gpt-5.5 / gpt-5.4 / gpt-5.4-mini); openai-api supports the full
    // dropdown. Pick the right resolver + default per provider so a stale
    // persisted id (e.g. gpt-5-mini after switching from openai-api to
    // codex-cli) is corrected to a working default.
    const openaiPricing = require("@gryphon/provider-runtime").pricing.openai;
    const isCodex = kind === "codex-cli";
    const options = isCodex
      ? openaiPricing.getCodexCliModelDropdownOptions()
      : openaiPricing.getModelDropdownOptions();
    const fallback = isCodex
      ? openaiPricing.CODEX_CLI_DEFAULT_MODEL
      : openaiPricing.DEFAULT_MODEL;
    return options.some((o) => o.id === current) ? current : fallback;
  }
  if (kind === "google-api" || kind === "gemini-cli") {
    // gemini-cli reuses the Gemini model dropdown — both go to the same
    // Google models, and pricing tables/aliases are identical.
    const { getModelDropdownOptions, DEFAULT_MODEL } =
      require("@gryphon/provider-runtime").pricing.google;
    const options = getModelDropdownOptions();
    return options.some((o) => o.id === current) ? current : DEFAULT_MODEL;
  }
  // claude-code / anthropic-api / null → Anthropic MODELS list.
  return MODELS.some((m) => m.value === current) ? current : "claude-sonnet-4-6";
}

/**
 * Model dropdown options ([{id, label}]) for a fallback provider KIND (issue
 * #15). Mirrors the per-vendor lists the Default-model dropdown uses, so the
 * Fallback-model picker offers exactly the models that kind can serve.
 */
function _fallbackModelOptions(kind) {
  const runtime = require("@gryphon/provider-runtime");
  if (kind === "openai-api") {
    return runtime.pricing.openai.getModelDropdownOptions().map((o) => ({ id: o.id, label: o.label }));
  }
  if (kind === "codex-cli") {
    return runtime.pricing.openai.getCodexCliModelDropdownOptions().map((o) => ({ id: o.id, label: o.label }));
  }
  if (kind === "google-api" || kind === "gemini-cli") {
    return runtime.pricing.google.getModelDropdownOptions().map((o) => ({ id: o.id, label: o.label }));
  }
  // anthropic-api / claude-code → Anthropic MODELS list.
  return MODELS.map((m) => ({ id: m.value, label: m.label }));
}

/**
 * Which credential field key(s) the Setup panel must render for a provider
 * preference. Returns null for "auto"/unknown — the caller then renders the
 * collapsed all-credentials group. The string keys map to the per-credential
 * row renderers below.
 */
function _credentialFieldsFor(pref) {
  switch (pref) {
    case "anthropic-api": return ["anthropicKey"];
    case "openai-api": return ["openaiKey"];
    case "google-api": return ["googleKey"];
    case "claude-code": return ["claudePath"];
    case "codex-cli": return ["codexPath"];
    case "gemini-cli": return ["geminiPath", "googleKey"];
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// Per-credential row renderers (bodies copied verbatim from renderGryphonSettings;
// originals stay in place until Task 6). Container variable → passed panelEl;
// API-key rows call refreshChip() instead of updateProviderReadiness().
// ---------------------------------------------------------------------------

/**
 * Shared CLI-path settings row — the single pattern ALL three CLI providers
 * (Claude / Codex / Gemini) use, so the rows can never drift apart again (the
 * drift that hid the gemini-detection bug). Renders: an inline detection status
 * pill on the row name (✓ detected at <path> / ⚠ not detected, with Flatpak
 * guidance), a path text field, and a Re-detect button that clears the binary
 * discovery cache and re-probes.
 *
 * @param opts.settingsKey  the `settings.*` key holding the manual path override
 * @param opts.findKey      provider-runtime export name (findClaudeBinary / …)
 * @param opts.cliLabel     human label for the pill tooltip ("Gemini CLI")
 * @param opts.installHint  not-detected tooltip (non-Flatpak)
 * @param opts.flatpakHint  short install pointer shown in the Flatpak tooltip
 */
function renderCliPathRow(host, panelEl, opts) {
  const { name, tooltip, settingsKey, findKey, defaultPlaceholder, cliLabel, installHint, flatpakHint } = opts;
  const cliSetting = descToTooltip(new Setting(panelEl).setName(name), tooltip);
  const cliStatusPill = cliSetting.nameEl.createEl("span", { cls: "gryphon-cli-status-pill" });

  const renderCliStatus = () => {
    cliStatusPill.empty();
    cliStatusPill.className = "gryphon-cli-status-pill";
    const manualPath = (host.settings[settingsKey] || "").trim();
    const runtime = require("@gryphon/provider-runtime");
    const flatpak = runtime.detectFlatpakSandbox();
    const detected = manualPath || runtime[findKey]();
    if (detected) {
      cliStatusPill.addClass("is-ok");
      const shown = runtime.displayPath(detected);
      cliStatusPill.setText(`✓ ${shown}`);
      attachHoverTooltip(cliStatusPill, `${cliLabel} detected at:\n${shown}`);
    } else if (flatpak.isFlatpak) {
      cliStatusPill.addClass("is-warn");
      cliStatusPill.setText("⚠ Not detected (Flatpak sandbox)");
      attachHoverTooltip(
        cliStatusPill,
        `Obsidian is running in a Flatpak sandbox (${flatpak.appId}) ` +
        `which can't see /usr/bin. Fix:\n\n` +
        `• Install ${cliLabel} somewhere under $HOME (${flatpakHint}), then Re-detect.\n\n` +
        `• OR grant sandbox access:\n` +
        `    flatpak override --user --filesystem=/usr:ro ${flatpak.appId}\n\n` +
        `Then restart Obsidian.`,
      );
    } else {
      cliStatusPill.addClass("is-warn");
      cliStatusPill.setText("⚠ Not detected");
      attachHoverTooltip(cliStatusPill, installHint);
    }
  };

  cliSetting
    .addText((text) => {
      const runtime = require("@gryphon/provider-runtime");
      const detected = runtime[findKey]();
      return text
        .setPlaceholder(detected ? runtime.displayPath(detected) : defaultPlaceholder)
        .setValue(host.settings[settingsKey] || "")
        .onChange(async (value) => {
          host.settings[settingsKey] = value.trim();
          await host.saveSettings();
          host._resetActiveSessions?.();
          renderCliStatus();
        });
    })
    .addButton((btn) =>
      btn
        .setButtonText("Re-detect")
        .setTooltip("Clear the discovery cache and probe again")
        .onClick(() => {
          require("@gryphon/provider-runtime").clearBinaryDiscoveryCache();
          // Re-detect may resolve a DIFFERENT binary (e.g. a freshly-installed
          // newer version) than the live session is bound to. Retire active
          // sessions so the next message rebinds — same teardown the path-field
          // onChange does, so the two stay consistent (consumer-teardown class).
          host._resetActiveSessions?.();
          renderCliStatus();
        }),
    );
  renderCliStatus();
}

function renderClaudePathRow(host, panelEl) {
  renderCliPathRow(host, panelEl, {
    name: "Claude Code path",
    tooltip:
      "Leave empty for auto-detect (checks common locations + your " +
      "login-shell PATH). Used in Claude Code mode only.",
    settingsKey: "claudePath",
    findKey: "findClaudeBinary",
    defaultPlaceholder: "/usr/local/bin/claude",
    cliLabel: "Claude CLI",
    installHint:
      "Gryphon checked common install locations and your login-shell PATH. " +
      "Install claude (npm / brew / apt) and restart Obsidian, or set the full " +
      "path in the field on the right if it's already installed in a " +
      "non-standard location.",
    flatpakHint: "e.g. npm config set prefix ~/.npm-global && npm install -g @anthropic-ai/claude-code",
  });
}

function renderAnthropicKeyRow(host, panelEl, refreshChip) {
  let keyStatusEl = null;
  descToTooltip(
    new Setting(panelEl).setName("Anthropic API key"),
    "Required for Anthropic API mode. Paste your key here — stored in plugin " +
    "data.json. (Advanced: ANTHROPIC_API_KEY env var also works, but " +
    "only if Obsidian was launched from a shell that has the variable. " +
    "macOS GUI launches via Finder/Dock/Spotlight do NOT see ~/.zshrc " +
    "env vars.)",
  )
    .addText((text) => {
      text.inputEl.type = "password";
      text
        .setPlaceholder("sk-ant-...")
        .setValue(host.settings.anthropicApiKey || "")
        .onChange(async (value) => {
          host.settings.anthropicApiKey = value.trim();
          await host.saveSettings();
          host._resetActiveSessions?.();
          if (keyStatusEl) keyStatusEl.setText("");
          refreshChip();
        });
    })
    .addButton((btn) =>
      btn
        .setButtonText("Test key")
        .onClick(async () => {
          btn.setDisabled(true).setButtonText("Testing...");
          const key =
            (host.settings.anthropicApiKey || "").trim() ||
            process.env.ANTHROPIC_API_KEY ||
            "";
          const { ok, message } = await testAnthropicApiKey(key);
          btn.setDisabled(false).setButtonText("Test key");
          if (keyStatusEl) {
            keyStatusEl.setText(ok ? `✓ ${message}` : `✗ ${message}`);
            keyStatusEl.setCssStyles({ color: ok ? "var(--color-green)" : "var(--color-red)" });
          }
          new Notice(`Anthropic API key: ${ok ? "OK" : message}`);
        })
    )
    .then((setting) => {
      keyStatusEl = setting.descEl.createDiv({ cls: "setting-item-description" });
      keyStatusEl.setCssStyles({ marginTop: "4px" });
    });
}

function renderOpenAIKeyRow(host, panelEl, refreshChip) {
  let openaiKeyStatusEl = null;
  descToTooltip(
    new Setting(panelEl).setName("OpenAI API key"),
    "Required for OpenAI API mode (v1.2.0). Paste your key here — " +
    "stored in plugin data.json. (Advanced: OPENAI_API_KEY env var " +
    "also works, but only if Obsidian was launched from a shell that " +
    "has the variable.)",
  )
    .addText((text) => {
      text.inputEl.type = "password";
      text
        .setPlaceholder("sk-...")
        .setValue(host.settings.openaiApiKey || "")
        .onChange(async (value) => {
          host.settings.openaiApiKey = value.trim();
          await host.saveSettings();
          host._resetActiveSessions?.();
          if (openaiKeyStatusEl) openaiKeyStatusEl.setText("");
          refreshChip();
        });
    })
    .addButton((btn) =>
      btn
        .setButtonText("Test key")
        .onClick(async () => {
          btn.setDisabled(true).setButtonText("Testing...");
          const key =
            (host.settings.openaiApiKey || "").trim() ||
            process.env.OPENAI_API_KEY ||
            "";
          const { ok, message } = await testOpenAIApiKey(key);
          btn.setDisabled(false).setButtonText("Test key");
          if (openaiKeyStatusEl) {
            openaiKeyStatusEl.setText(ok ? `✓ ${message}` : `✗ ${message}`);
            openaiKeyStatusEl.setCssStyles({ color: ok ? "var(--color-green)" : "var(--color-red)" });
          }
          new Notice(`OpenAI API key: ${ok ? "OK" : message}`);
        })
    )
    .then((setting) => {
      openaiKeyStatusEl = setting.descEl.createDiv({ cls: "setting-item-description" });
      openaiKeyStatusEl.setCssStyles({ marginTop: "4px" });
    });
}

function renderGoogleKeyRow(host, panelEl, refreshChip) {
  let googleKeyStatusEl = null;
  descToTooltip(
    new Setting(panelEl).setName("Google API key"),
    "Required for Google Gemini API mode (v1.2.0). Paste your key " +
    "here — stored in plugin data.json. Get one free at " +
    "aistudio.google.com/apikey. (Advanced: GOOGLE_API_KEY env var " +
    "also works, but only if Obsidian was launched from a shell that " +
    "has the variable.)",
  )
    .addText((text) => {
      text.inputEl.type = "password";
      text
        .setPlaceholder("AIza...")
        .setValue(host.settings.googleApiKey || "")
        .onChange(async (value) => {
          host.settings.googleApiKey = value.trim();
          await host.saveSettings();
          host._resetActiveSessions?.();
          if (googleKeyStatusEl) googleKeyStatusEl.setText("");
          refreshChip();
        });
    })
    .addButton((btn) =>
      btn
        .setButtonText("Test key")
        .onClick(async () => {
          btn.setDisabled(true).setButtonText("Testing...");
          const key =
            (host.settings.googleApiKey || "").trim() ||
            process.env.GOOGLE_API_KEY ||
            "";
          const { ok, message } = await testGoogleApiKey(key, host.hostAdapter);
          btn.setDisabled(false).setButtonText("Test key");
          if (googleKeyStatusEl) {
            googleKeyStatusEl.setText(ok ? `✓ ${message}` : `✗ ${message}`);
            googleKeyStatusEl.setCssStyles({ color: ok ? "var(--color-green)" : "var(--color-red)" });
          }
          new Notice(`Google API key: ${ok ? "OK" : message}`);
        })
    )
    .then((setting) => {
      googleKeyStatusEl = setting.descEl.createDiv({ cls: "setting-item-description" });
      googleKeyStatusEl.setCssStyles({ marginTop: "4px" });
    });
}

function renderCodexPathRow(host, panelEl) {
  renderCliPathRow(host, panelEl, {
    name: "Codex CLI path",
    tooltip:
      "Optional. Required only when Provider is Codex CLI. Empty string " +
      "auto-detects: macOS checks /Applications/Codex.app/Contents/Resources/codex " +
      "first, then PATH and common bin directories. Auth is handled by the " +
      "CLI itself — run `codex login` in a terminal once after installing.",
    settingsKey: "codexPath",
    findKey: "findCodexBinary",
    defaultPlaceholder: "/Applications/Codex.app/Contents/Resources/codex",
    cliLabel: "Codex CLI",
    installHint:
      "Gryphon checked common install locations and your login-shell PATH. " +
      "Install Codex from https://chatgpt.com/codex (the macOS app installs the " +
      "CLI), or set the full path in the field on the right if it's already " +
      "installed in a non-standard location. After installing, run `codex login`.",
    flatpakHint: "see https://chatgpt.com/codex",
  });
}

function renderGeminiPathRow(host, panelEl) {
  renderCliPathRow(host, panelEl, {
    name: "Gemini CLI path",
    tooltip:
      "Optional. Required only when Provider is Gemini CLI. Empty string " +
      "auto-detects via PATH and common bin directories. Auth uses the " +
      "Google API key field above (forwarded as GEMINI_API_KEY env var " +
      "to the CLI).",
    settingsKey: "geminiCliPath",
    findKey: "findGeminiBinary",
    defaultPlaceholder: "/opt/homebrew/bin/gemini",
    cliLabel: "Gemini CLI",
    installHint:
      "Gryphon checked common install locations and your login-shell PATH. " +
      "Install via `npm install -g @google/gemini-cli` and restart Obsidian, " +
      "or set the full path in the field on the right if it's already " +
      "installed in a non-standard location.",
    flatpakHint: "e.g. npm config set prefix ~/.npm-global && npm install -g @google/gemini-cli",
  });
}

// credential-key -> renderer. Key rows take refreshChip; path rows ignore it.
function _renderCredentialRow(key, host, panelEl, refreshChip) {
  switch (key) {
    case "anthropicKey": return renderAnthropicKeyRow(host, panelEl, refreshChip);
    case "openaiKey":    return renderOpenAIKeyRow(host, panelEl, refreshChip);
    case "googleKey":    return renderGoogleKeyRow(host, panelEl, refreshChip);
    case "claudePath":   return renderClaudePathRow(host, panelEl);
    case "codexPath":    return renderCodexPathRow(host, panelEl);
    case "geminiPath":   return renderGeminiPathRow(host, panelEl);
    default: throw new Error(`unknown credential key: ${key}`);
  }
}

const ALL_CREDENTIAL_KEYS = [
  "anthropicKey", "openaiKey", "googleKey",
  "claudePath", "codexPath", "geminiPath",
];

/**
 * Setup rows: quick-start callout + readiness chip + Provider dropdown +
 * provider-scoped credentials. (Fallback rows render separately, last in the
 * Models tab — see `renderFallbackRows`.)
 *
 * @param hostPlugin  minimal duck type `{ settings, saveSettings }`.
 * @param panelEl     element this panel owns and renders into.
 * @param ctx         `{ rerenderSelf, rerenderAll }` from the tab harness.
 */
function renderSetupPanel(hostPlugin, panelEl, ctx) {
  // No "Provider" section heading — the tab is already labelled "Models" and
  // the Provider dropdown immediately follows, so a heading would just repeat
  // the word "Provider".

  // Proactive provider readiness (issue #16). When the selected provider can't
  // run, the Provider dropdown itself goes red-bordered and reveals the reason
  // on hover — no separate warning icon needed.
  let providerSelectEl = null;
  const updateProviderReadiness = () => {
    if (!providerSelectEl) return;
    const { describeProviderReadiness, humanizeFailureReason } = require("@gryphon/provider-runtime");
    const { ready, reason } = describeProviderReadiness(hostPlugin);
    const bad = !ready && !!reason;
    if (typeof providerSelectEl.toggleClass === "function") {
      providerSelectEl.toggleClass("gryphon-input-error", bad);
    }
    if (bad) {
      const why = humanizeFailureReason(reason);
      const detail =
        `${why.charAt(0).toUpperCase()}${why.slice(1)} — this provider can't run, ` +
        `so it won't be used for your requests. Fix it above, or choose a ` +
        `different provider.`;
      attachHoverTooltip(providerSelectEl, detail);
    } else {
      // Usable again — clear any stale warning so hovering the dropdown is silent.
      providerSelectEl._gryphonTip = "";
    }
  };

  descToTooltip(
    new Setting(panelEl).setName("Provider"),
    "SDK uses the Anthropic API directly (recommended — pay-per-token, " +
    "unambiguously covered by your Anthropic API agreement). CLI spawns " +
    "a locally-installed `claude` binary as a subprocess — confirm your " +
    "usage complies with Anthropic's terms before enabling.",
  )
    .addDropdown((drop) => {
      providerSelectEl = drop.selectEl;
      for (const p of PROVIDER_PREFS) drop.addOption(p.value, `${p.label} — ${p.desc}`);
      drop.setValue(hostPlugin.settings.providerPreference || "auto");
      drop.onChange(async (value) => {
        const prevPreference = hostPlugin.settings.providerPreference || "auto";
        hostPlugin.settings.providerPreference = value;
        hostPlugin.settings.model = _resetModelForProvider(hostPlugin);
        await hostPlugin.saveSettings();
        hostPlugin._resetActiveSessions?.();
        if (prevPreference !== value) {
          hostPlugin._announceProviderChange?.(prevPreference, value);
        }
        ctx.rerenderAll();
      });
    })
    .then(() => {
      updateProviderReadiness();
    });

  // Provider-scoped credentials.
  const pref = hostPlugin.settings.providerPreference || "auto";
  const fields = _credentialFieldsFor(pref);
  if (fields) {
    for (const key of fields) {
      _renderCredentialRow(key, hostPlugin, panelEl, updateProviderReadiness);
    }
  } else {
    // auto / unknown → collapsed group with ALL credential fields.
    const details = panelEl.createEl("details", { cls: "gryphon-credentials-group" });
    details.createEl("summary", { text: "Configure credentials", cls: "gryphon-credentials-summary" });
    for (const key of ALL_CREDENTIAL_KEYS) {
      _renderCredentialRow(key, hostPlugin, details, updateProviderReadiness);
    }
  }

}

/**
 * Fallback provider + model rows (issue #15). Rendered LAST in the Models tab —
 * after the primary provider/credentials AND the default model settings — so the
 * secondary failover choice never splits the primary model configuration.
 * Fallback-provider change re-renders the whole Models panel (`ctx.rerenderSelf`)
 * so the conditional Fallback-model row appears/updates.
 */
function renderFallbackRows(hostPlugin, panelEl, ctx) {
  descToTooltip(
    new Setting(panelEl).setName("Fallback provider"),
    "When the active provider can't serve a request — no key/CLI, invalid " +
    "key, no credit, quota, or rate-limit — Gryphon retries once with this " +
    "provider and reports which one answered. Genuine content errors never " +
    "trigger failover. 'No fallback' surfaces a clear error instead.",
  )
    .addDropdown((drop) => {
      for (const p of FALLBACK_PROVIDER_PREFS) drop.addOption(p.value, `${p.label} — ${p.desc}`);
      drop.setValue(hostPlugin.settings.fallbackProviderPreference || "none");
      drop.onChange(async (value) => {
        hostPlugin.settings.fallbackProviderPreference = value;
        if (value === "none" || value === "auto") {
          hostPlugin.settings.fallbackModel = "";
        } else {
          const opts = _fallbackModelOptions(value);
          const current = hostPlugin.settings.fallbackModel;
          hostPlugin.settings.fallbackModel =
            opts.some((o) => o.id === current) ? current : (opts[0] ? opts[0].id : "");
        }
        await hostPlugin.saveSettings();
        ctx.rerenderSelf();
      });
    });

  // Fallback model — only meaningful for an explicit fallback provider.
  const fbPref = hostPlugin.settings.fallbackProviderPreference || "none";
  if (fbPref !== "none" && fbPref !== "auto") {
    const fbModels = _fallbackModelOptions(fbPref);
    if (fbModels.length && !fbModels.some((o) => o.id === hostPlugin.settings.fallbackModel)) {
      hostPlugin.settings.fallbackModel = fbModels[0].id;
      hostPlugin.saveSettings();
    }
    new Setting(panelEl)
      .setName("Fallback model")
      .addDropdown((drop) => {
        for (const m of fbModels) drop.addOption(m.id, m.label);
        drop.setValue(hostPlugin.settings.fallbackModel || (fbModels[0] && fbModels[0].id) || "");
        drop.onChange(async (value) => {
          hostPlugin.settings.fallbackModel = value;
          await hostPlugin.saveSettings();
        });
      });
  }
}

// Self-owned hover tooltip. Neither Obsidian's setTooltip nor the native
// `title` attribute renders reliably inside the settings modal (Obsidian's
// tooltip layer misbehaves there, and Obsidian suppresses native titles
// app-wide), so we own the whole thing: a single body-appended, position-fixed
// element shown on mouseenter. Immune to Obsidian's tooltip system, native
// suppression, and settings-container clipping.
let _hoverTipEl: any = null;
function _hoverTip() {
  const doc = (typeof activeDocument !== "undefined" ? activeDocument : document) as any;
  if (!_hoverTipEl || !(doc.body && doc.body.contains(_hoverTipEl))) {
    // Visibility is class-driven (.is-visible); position is set dynamically
    // via setCssStyles — both keep `element.style.* =` out of the code per the
    // obsidianmd no-static-styles-assignment rule.
    _hoverTipEl = doc.body.createDiv({ cls: "gryphon-hover-tooltip" });
  }
  return _hoverTipEl;
}
/**
 * Remove the body-appended hover-tooltip singleton. Obsidian asks plugins to
 * clean up DOM they add to `document.body`; the standalone plugin calls this
 * from `onunload()`. Safe to call when nothing was ever shown (no-op).
 */
function disposeHoverTooltip() {
  if (_hoverTipEl && typeof _hoverTipEl.remove === "function") _hoverTipEl.remove();
  _hoverTipEl = null;
}

function attachHoverTooltip(el, text) {
  if (!el || !text || typeof el.addEventListener !== "function") return;
  // Idempotent: store the (possibly updated) text and bind listeners once, so
  // callers that re-render the same element (e.g. the CLI status pill) don't
  // stack duplicate handlers.
  el._gryphonTip = text;
  // NB: deliberately NOT setting aria-label — Obsidian's global tooltip handler
  // fires on aria-label and would render a SECOND (native) tooltip on top of
  // this self-owned one.
  if (el._gryphonTipBound) return;
  el._gryphonTipBound = true;
  // mouseover/mouseout rather than mouseenter/leave: they fire more eagerly
  // (including right after the window regains focus) so the tooltip doesn't
  // need a priming click. mouseout to a child is ignored so it doesn't flicker.
  const show = () => {
    if (!el._gryphonTip) return;
    const tip = _hoverTip();
    tip.empty();
    tip.setText(el._gryphonTip);
    tip.addClass("is-visible");
    const r = el.getBoundingClientRect();
    const win = (typeof activeWindow !== "undefined" ? activeWindow : window) as any;
    const tipW = tip.offsetWidth || 0;
    let left = r.left;
    const max = (win.innerWidth || 0) - tipW - 8;
    if (max > 0 && left > max) left = Math.max(8, max);
    tip.setCssStyles({ left: `${Math.round(left)}px`, top: `${Math.round(r.bottom + 6)}px` });
  };
  const hide = () => { if (_hoverTipEl) _hoverTipEl.removeClass("is-visible"); };
  el.addEventListener("mouseover", show);
  el.addEventListener("mouseout", (e: any) => {
    if (e && e.relatedTarget && el.contains && el.contains(e.relatedTarget)) return;
    hide();
  });
}

/**
 * Collapse a Setting row's description into a hover tooltip, attached to an
 * `(i)` info icon appended to the row's name span. Shared by the renderer and
 * (via delegation) by GryphonSettingTab's Gryphon-only zone so the info-icon
 * affordance is consistent across the whole settings tab.
 */
function descToTooltip(setting, tooltipText) {
  if (!setting || !tooltipText) return setting;
  setting.setDesc("");
  const info = setting.nameEl.createEl("span", {
    cls: "gryphon-info-icon gryphon-info-icon-inline",
    attr: { tabindex: "0" },
  });
  info.createEl("span", { text: "i", cls: "gryphon-info-icon-glyph" });
  attachHoverTooltip(info, tooltipText);
  return setting;
}

/**
 * Render a section heading. With no `toggleKey` it's a lightweight h3-style
 * div (Provider / Defaults / Diagnostics). With a `toggleKey` it renders as
 * an Obsidian Setting row carrying a master toggle bound to
 * `plugin.settings[toggleKey]` — used by the Gryphon-only Security zone, which
 * is why this helper takes `plugin` explicitly (the renderer's portable zone
 * only ever uses the no-toggle form).
 */
function renderSectionHeading(parentEl, opts, plugin) {
  const { title, tooltip, toggleKey, onToggle } = opts;

  if (!toggleKey) {
    const wrap = parentEl.createEl("div", { cls: "gryphon-section-heading" });
    wrap.createEl("div", { text: title, cls: "gryphon-section-heading-label" });
    if (tooltip) {
      const info = wrap.createEl("span", {
        cls: "gryphon-info-icon",
        attr: { tabindex: "0" },
      });
      info.createEl("span", { text: "i", cls: "gryphon-info-icon-glyph" });
      attachHoverTooltip(info, tooltip);
    }
    return wrap;
  }

  const setting = new Setting(parentEl).setName(title);
  setting.settingEl.classList.add(
    "gryphon-section-heading",
    "gryphon-section-heading-row",
  );
  if (tooltip) descToTooltip(setting, tooltip);
  else setting.setDesc("");
  setting.addToggle((toggle) => {
    const current = plugin.settings[toggleKey] !== false;
    toggle.setValue(current).onChange(async (value) => {
      plugin.settings[toggleKey] = !!value;
      await plugin.saveSettings();
      if (onToggle) onToggle(!!value);
    });
  });
  return setting;
}

/**
 * Render Gryphon's portable config zone (Provider + Defaults) into
 * `containerEl`.
 *
 * @param hostPlugin  minimal duck type `{ settings, saveSettings }`; may also
 *                    carry `app` + Gryphon-internal methods (all optional).
 * @param containerEl element the renderer owns and re-renders.
 * @param options     `{ chrome?, extraTabs?, initialTabId?, onTabChange? }`
 *                    - `chrome` (default true): when false, suppress the
 *                      quick-start callout + manual link (the embedded case).
 *                    - `extraTabs`: additional `TabDescriptor[]` appended after
 *                      the built-in Setup/Defaults/Advanced tabs.
 *                    - `initialTabId`: which tab to activate on first render.
 *                    - `onTabChange`: called with the tab id on activation.
 */
function renderGryphonSettings(hostPlugin, containerEl, options) {
  options = options || {};
  const { renderTabbedSettings } = require("./settings-tabs");

  const extraTabs = Array.isArray(options.extraTabs) ? options.extraTabs : [];

  const tabs = [
    // "Models" combines provider selection + scoped credentials + fallback
    // (Setup) with the per-session default model / effort / permissions
    // (Defaults) — they're all "which model am I talking to, and how" — into
    // one tab. "Models" is the term Cursor / Continue / OpenRouter / Jan /
    // LM Studio use for this surface.
    {
      id: "models",
      label: "Models",
      render: (panelEl, ctx) => {
        // Two outlined groups so the primary model choice and the fallback
        // read as distinct sections. Provider + credentials + per-session
        // defaults form the "Model" group; the failover provider/model is its
        // own "Fallback" group below it.
        const modelGroup = panelEl.createDiv("gryphon-settings-group");
        modelGroup.createDiv({ cls: "gryphon-settings-group-label", text: "Model" });
        renderSetupPanel(hostPlugin, modelGroup, ctx);
        renderDefaultsPanel(hostPlugin, modelGroup, ctx);

        const fallbackGroup = panelEl.createDiv("gryphon-settings-group");
        fallbackGroup.createDiv({ cls: "gryphon-settings-group-label", text: "Fallback" });
        renderFallbackRows(hostPlugin, fallbackGroup, ctx);
      },
    },
    { id: "advanced", label: "Advanced", render: (panelEl, ctx) => renderAdvancedPanel(hostPlugin, panelEl, ctx) },
    ...extraTabs,
  ];

  return renderTabbedSettings(containerEl, tabs, {
    initialTabId: options.initialTabId,
    onTabChange: options.onTabChange,
  });
}

/**
 * Advanced tab: optional Brave key + tuning toggles + connection timeout +
 * max file size. Niche knobs kept out of the primary Setup path.
 */
function renderAdvancedPanel(hostPlugin, panelEl, ctx) {
  // Copy verbatim (originals remain in the flat renderGryphonSettings until
  // Task 6 deletes them), rendering into `panelEl` instead of `containerEl`.
  // No logic change.

  descToTooltip(
    new Setting(panelEl).setName("Brave Search API key"),
    "Optional. Enables SDK-mode WebSearch. Free at brave.com/search/api/ " +
    "(2000 queries/month). Claude Code mode uses Anthropic's built-in search and " +
    "ignores this.",
  )
    .addText((text) => {
      text.inputEl.type = "password";
      text
        .setPlaceholder("BSA...")
        .setValue(hostPlugin.settings.braveSearchApiKey || "")
        .onChange(async (value) => {
          hostPlugin.settings.braveSearchApiKey = value.trim();
          await hostPlugin.saveSettings();
          hostPlugin._resetActiveSessions?.();
        });
    });

  descToTooltip(
    new Setting(panelEl).setName("Auto-compact at 95% (SDK mode)"),
    "Automatically summarize and reset the conversation when context " +
    "fills up. Disable to get an explicit \"context full\" warning at " +
    "95% and run /compact manually instead. Claude Code mode handles " +
    "its own auto-compaction and ignores this.",
  )
    .addToggle((toggle) =>
      toggle.setValue(hostPlugin.settings.autoCompactSdk !== false).onChange(async (value) => {
        hostPlugin.settings.autoCompactSdk = value;
        await hostPlugin.saveSettings();
      })
    );

  // Issue #34 deferred: opt-in auto-retry on rate-limit. Off by
  // default — automatic retries can pile up unintended cost on
  // metered APIs. When on, a single retry fires after the parsed
  // retry-after window (capped at 60s); a second 429 does not chain.
  descToTooltip(
    new Setting(panelEl).setName("Auto-retry on rate-limit"),
    "When a send fails with a rate-limit error and the response " +
    "includes a precise retry-after delay (≤60s), Gryphon will " +
    "automatically resubmit your prompt once after the window expires. " +
    "If turned off, your prompt is preserved in the input box and " +
    "you press Send manually when ready. Per-day quota errors are " +
    "never auto-retried.",
  )
    .addToggle((toggle) =>
      toggle.setValue(hostPlugin.settings.autoRetryOnRateLimit === true).onChange(async (value) => {
        hostPlugin.settings.autoRetryOnRateLimit = value;
        await hostPlugin.saveSettings();
      })
    );

  // v1.7.0 F1 — opt-out for SDK-mode authoritative token counting.
  // Anthropic's `messages.countTokens` endpoint is free (no charge,
  // no generation) and gives an exact pre-send token count. Default
  // on. Users who prefer zero "background" network activity can
  // disable; the heuristic estimator handles both CLI mode and the
  // SDK-disabled path.
  descToTooltip(
    new Setting(panelEl).setName("Use exact token counts (SDK mode)"),
    "When using the Anthropic API provider, Gryphon calls the free " +
    "messages.countTokens endpoint on debounced typing pauses to show " +
    "an exact projected context size before send. Anthropic does not " +
    "charge for this endpoint. Disable to keep all pre-send context " +
    "computation strictly local (the heuristic estimator is used as " +
    "the fallback). CLI providers (claude-code / codex-cli / gemini-cli) " +
    "are unaffected — they always use the local heuristic.",
  )
    .addToggle((toggle) =>
      toggle.setValue(hostPlugin.settings.useExactTokenCounting !== false).onChange(async (value) => {
        hostPlugin.settings.useExactTokenCounting = value;
        await hostPlugin.saveSettings();
      })
    );

  // v1.7.0 F1 — confirm modal when projected context is ≥95% of the
  // model's window. Default on. Users who push the limit on purpose
  // (one-shot long-context prompts where they know what they're doing)
  // can disable so the modal doesn't get in the way.
  descToTooltip(
    new Setting(panelEl).setName("Confirm before overflow sends"),
    "When the projected context for the next send is at or above " +
    "95% of the model's window, Gryphon shows a confirmation modal " +
    "with recovery suggestions (switch model / /compact / /clear). " +
    "Disable to send without confirmation even when overflow is likely.",
  )
    .addToggle((toggle) =>
      toggle.setValue(hostPlugin.settings.confirmOnContextOverflow !== false).onChange(async (value) => {
        hostPlugin.settings.confirmOnContextOverflow = value;
        await hostPlugin.saveSettings();
      })
    );

  // v1.7.0 F4 — Obsidian REST API access policy. Blocks claude-code's
  // built-in WebFetch from reaching the obsidian-local-rest-api
  // plugin on loopback (127.0.0.1:27124). Default blocked because
  // unrestricted access has been seen producing 500+ enumeration GETs
  // per question when vault-native search would close it in one call.
  // Users who actually want REST integration can flip this on per
  // session via the chat toolbar chip; the setting here defines the
  // start-of-session default.
  descToTooltip(
    new Setting(panelEl).setName("Block Obsidian REST API access"),
    "When on (default), Gryphon denies WebFetch calls to the Obsidian " +
    "REST API plugin on loopback. This prevents the language model " +
    "from enumerating the vault via REST when a single grep would " +
    "answer the same question. Turn off to let the model reach " +
    "127.0.0.1:27124 freely; a warning toast still fires when GETs " +
    "exceed the threshold below in one turn.",
  )
    .addToggle((toggle) =>
      toggle.setValue((hostPlugin.settings.obsidianRestApiPolicy || "blocked") === "blocked").onChange(async (value) => {
        hostPlugin.settings.obsidianRestApiPolicy = value ? "blocked" : "allowed";
        await hostPlugin.saveSettings();
        try {
          // Preserve the cross-plugin contract: consumers listen on this
          // event for live provider/model teardown (Gryphon 2.4.4). Guard
          // the whole chain so a minimal host without app/workspace is safe.
          hostPlugin.app?.workspace?.trigger?.("gryphon:settings-changed");
        } catch { /* best-effort */ }
      })
    );

  // Issue #38: cold-start connection-timeout override. Empty input
  // (or out-of-range) means "use the model-adaptive default" —
  // Haiku 30s, Sonnet 60s, Opus 120s, Opus 1M 180s, others 60s.
  // Bounds chosen so users can't disable the timer or set it so
  // long that a hung process is indistinguishable from a slow one.
  //
  // Round 4 review (SFH-4): a status line below the field shows the
  // EFFECTIVE timeout (override or model default) so the user
  // doesn't have to guess what was accepted. A typed "5000" (rejected
  // — out of range, user probably meant ms) shows the validation
  // error AND the effective fallback, so the input never silently
  // disappears into the void.
  let timeoutStatusEl = null;
  const updateTimeoutStatus = (rawInput) => {
    if (!timeoutStatusEl) return;
    const trimmed = (rawInput || "").trim();
    const effectiveMs = resolveConnectionTimeoutMs({
      override: hostPlugin.settings.connectionTimeoutMs,
      model: hostPlugin.settings.model,
    });
    const effectiveSec = Math.round(effectiveMs / 1000);
    // Validation feedback for the current input value:
    let prefix;
    let color = "";
    if (!trimmed) {
      prefix = `Using model-adaptive default: ${effectiveSec}s`;
    } else {
      const sec = Number(trimmed);
      if (Number.isFinite(sec) && sec >= 5 && sec <= 600) {
        prefix = `✓ Override active: ${effectiveSec}s`;
        color = "var(--color-green)";
      } else {
        prefix = `✗ Invalid: must be 5–600 seconds. Currently using: ${effectiveSec}s`;
        color = "var(--color-red)";
      }
    }
    timeoutStatusEl.setText(prefix);
    timeoutStatusEl.setCssStyles({ color });
  };

  descToTooltip(
    new Setting(panelEl).setName("Connection timeout (seconds)"),
    "How long to wait for the model's first token before treating " +
    "the request as stuck. Leave empty for the model-adaptive " +
    "default (Haiku 30s, Sonnet 60s, Opus 120s, Opus 1M 180s; " +
    "non-Anthropic providers 60s). Set 5–600 to override for slow " +
    "networks or unusually large prompts.",
  )
    .addText((text) => {
      const stored = hostPlugin.settings.connectionTimeoutMs;
      const display = (typeof stored === "number" && Number.isFinite(stored) && stored > 0)
        ? String(Math.round(stored / 1000))
        : "";
      text
        .setPlaceholder("default")
        .setValue(display)
        .onChange(async (value) => {
          const trimmed = (value || "").trim();
          if (!trimmed) {
            hostPlugin.settings.connectionTimeoutMs = null;
            await hostPlugin.saveSettings();
            updateTimeoutStatus(value);
            return;
          }
          const sec = Number(trimmed);
          if (Number.isFinite(sec) && sec >= 5 && sec <= 600) {
            hostPlugin.settings.connectionTimeoutMs = Math.round(sec) * 1000;
            await hostPlugin.saveSettings();
          }
          // Out-of-range or non-numeric: don't persist. The status
          // line below the field shows the validation error AND the
          // effective fallback so the user knows their input was
          // rejected and what's currently active.
          updateTimeoutStatus(value);
        });
    })
    .then((setting) => {
      timeoutStatusEl = setting.descEl.createDiv({ cls: "setting-item-description" });
      timeoutStatusEl.setCssStyles({ marginTop: "4px", fontStyle: "italic" });
      // Initial render — show the current effective timeout from the
      // stored setting so the user sees their last-saved state.
      const stored = hostPlugin.settings.connectionTimeoutMs;
      const initialDisplay = (typeof stored === "number" && Number.isFinite(stored) && stored > 0)
        ? String(Math.round(stored / 1000))
        : "";
      updateTimeoutStatus(initialDisplay);
    });

  descToTooltip(
    new Setting(panelEl).setName("Max file size (MB)"),
    "Upper bound on the size of a single file that Read or Edit " +
    "will load. Larger files are refused with a pointer to " +
    "offset/limit or Grep. Default 10 MB — raise with caution; " +
    "very large files can slow Obsidian.",
  )
    .addText((text) =>
      text
        .setPlaceholder("10")
        .setValue(String(hostPlugin.settings.maxReadFileSizeMb ?? 10))
        .onChange(async (value) => {
          const n = Number(value);
          if (Number.isFinite(n) && n > 0) {
            hostPlugin.settings.maxReadFileSizeMb = n;
            await hostPlugin.saveSettings();
          }
        })
    );
}

/**
 * Defaults tab: provider-aware Default model + Default effort + Default
 * permissions + Open-in-main-tab. (Per-session defaults, also reachable from
 * the chat toolbar.)
 */
function renderDefaultsPanel(hostPlugin, panelEl, _ctx) {
  // Per-provider Default model + Default effort. When an adapter is
  // shipped, dropdowns read its native model list (with effort options
  // where applicable). When the adapter is still pending (google-api in
  // v1.2 — Stage 3), show a disabled row with a "pending" hint.
  // Use the resolved active provider (auto-fallthrough), not the literal
  // preference — so an Auto user with only an OpenAI key sees OpenAI's
  // model list here, matching what the chat-view toolbar shows.
  const { getActiveProviderKind } = require("@gryphon/provider-runtime");
  const activePref = getActiveProviderKind(hostPlugin) ||
                     hostPlugin.settings.providerPreference || "auto";

  if (activePref === "google-api" || activePref === "gemini-cli") {
    // Gemini adapter shipped Stage 3 — render the real Gemini model
    // dropdown with the same auto-correct pattern as the OpenAI branch:
    // if the persisted settings.model isn't a Gemini id (e.g. cross-vendor
    // carryover), persist a sensible Gemini default before display.
    const {
      getModelDropdownOptions: getGeminiOptions,
      resolveModel: resolveGeminiModel,
      DEFAULT_MODEL: GEMINI_DEFAULT_MODEL,
    } = require("@gryphon/provider-runtime").pricing.google;
    const geminiModels = getGeminiOptions();

    const isKnown = geminiModels.some((o) => o.id === hostPlugin.settings.model);
    if (!isKnown) {
      const resolved = resolveGeminiModel(hostPlugin.settings.model);
      const fitsDropdown = geminiModels.some((o) => o.id === resolved);
      const persistTarget = fitsDropdown ? resolved : GEMINI_DEFAULT_MODEL;
      if (hostPlugin.settings.model !== persistTarget) {
        hostPlugin.settings.model = persistTarget;
        hostPlugin.saveSettings();
      }
    }

    new Setting(panelEl)
      .setName("Default model")
      .addDropdown((drop) => {
        for (const m of geminiModels) drop.addOption(m.id, m.label);
        drop.setValue(hostPlugin.settings.model);
        drop.onChange(async (value) => {
          hostPlugin.settings.model = value;
          await hostPlugin.saveSettings();
          hostPlugin._resetActiveSessions?.();
        });
      });

    new Setting(panelEl)
      .setName("Default effort")
      .addDropdown((drop) => {
        for (const e of EFFORTS) drop.addOption(e.value, `${e.label} — ${e.desc}`);
        drop.setValue(hostPlugin.settings.effort);
        drop.onChange(async (value) => {
          hostPlugin.settings.effort = value;
          await hostPlugin.saveSettings();
          hostPlugin._resetActiveSessions?.();
        });
      });
  } else if (activePref === "openai-api" || activePref === "codex-cli") {
    // OpenAI's reasoning models (o-series) take a `reasoning.effort`
    // request param but the chat-completions models don't. For v1.2
    // we surface the same effort dropdown as Anthropic so the panel
    // header pattern is consistent — the openai-api provider ignores
    // effort for non-reasoning models. Stage 5 may add per-model
    // gating if user feedback warrants it.
    //
    // codex-cli vs openai-api: Codex CLI's ChatGPT-account auth path
    // rejects API-only ids (gpt-5-mini, gpt-4*, o3, o4-mini) with a
    // 400 at request time. Filter the dropdown + use the codex-specific
    // resolver/default so users on codex-cli see only the empirically-
    // supported subset (gpt-5.5 / gpt-5.4 / gpt-5.4-mini).
    const openaiPricing = require("@gryphon/provider-runtime").pricing.openai;
    const isCodex = activePref === "codex-cli";
    const openaiModels = isCodex
      ? openaiPricing.getCodexCliModelDropdownOptions()
      : openaiPricing.getModelDropdownOptions();
    const resolveModelFn = isCodex
      ? openaiPricing.coerceToCodexCliModel
      : openaiPricing.resolveModel;
    const fallbackDefault = isCodex
      ? openaiPricing.CODEX_CLI_DEFAULT_MODEL
      : openaiPricing.DEFAULT_MODEL;

    // Round 18 F23-1 fix (extended for codex-cli): when the persisted
    // settings.model is a non-OpenAI id (e.g. "sonnet" carried over
    // from prior Anthropic use) OR an API-only id while codex-cli is
    // active (e.g. "gpt-5-mini"), three surfaces would otherwise
    // disagree:
    //   • this dropdown's visual default
    //   • the chat-view toolbar's modelButtonText
    //   • the runtime resolver's actual spawn target
    // Resolve through the active resolver, fall back to the active
    // default if the result isn't in the dropdown, and PERSIST so all
    // surfaces converge.
    const isKnown = openaiModels.some((o) => o.id === hostPlugin.settings.model);
    if (!isKnown) {
      const resolved = resolveModelFn(hostPlugin.settings.model);
      const fitsDropdown = openaiModels.some((o) => o.id === resolved);
      const persistTarget = fitsDropdown ? resolved : fallbackDefault;
      if (hostPlugin.settings.model !== persistTarget) {
        hostPlugin.settings.model = persistTarget;
        // fire-and-forget save during render is safe — saveSettings is
        // idempotent + the UI re-renders below with the new value.
        hostPlugin.saveSettings();
      }
    }

    new Setting(panelEl)
      .setName("Default model")
      .addDropdown((drop) => {
        for (const m of openaiModels) drop.addOption(m.id, m.label);
        drop.setValue(hostPlugin.settings.model);
        drop.onChange(async (value) => {
          hostPlugin.settings.model = value;
          await hostPlugin.saveSettings();
          hostPlugin._resetActiveSessions?.();
        });
      });

    new Setting(panelEl)
      .setName("Default effort")
      .addDropdown((drop) => {
        for (const e of EFFORTS) drop.addOption(e.value, `${e.label} — ${e.desc}`);
        drop.setValue(hostPlugin.settings.effort);
        drop.onChange(async (value) => {
          hostPlugin.settings.effort = value;
          await hostPlugin.saveSettings();
          hostPlugin._resetActiveSessions?.();
        });
      });
  } else {
    new Setting(panelEl)
      .setName("Default model")
      .addDropdown((drop) => {
        for (const m of MODELS) drop.addOption(m.value, `${m.label} — ${m.desc}`);
        drop.setValue(hostPlugin.settings.model);
        drop.onChange(async (value) => {
          hostPlugin.settings.model = value;
          await hostPlugin.saveSettings();
          hostPlugin._resetActiveSessions?.();
        });
      });

    new Setting(panelEl)
      .setName("Default effort")
      .addDropdown((drop) => {
        for (const e of EFFORTS) drop.addOption(e.value, `${e.label} — ${e.desc}`);
        drop.setValue(hostPlugin.settings.effort);
        drop.onChange(async (value) => {
          hostPlugin.settings.effort = value;
          await hostPlugin.saveSettings();
          hostPlugin._resetActiveSessions?.();
        });
      });
  }

  new Setting(panelEl)
    .setName("Default permissions")
    .addDropdown((drop) => {
      for (const p of PERMS) drop.addOption(p.value, `${p.label} — ${p.desc}`);
      drop.setValue(hostPlugin.settings.permissionMode);
      drop.onChange(async (value) => {
        hostPlugin.settings.permissionMode = value;
        await hostPlugin.saveSettings();
        hostPlugin._resetActiveSessions?.();
      });
    });

  descToTooltip(
    new Setting(panelEl).setName("Open in main tab"),
    "Open chat in the main editor area instead of the sidebar " +
    "(takes effect next time the chat is opened).",
  )
    .addToggle((toggle) =>
      toggle.setValue(hostPlugin.settings.openInMainTab).onChange(async (value) => {
        hostPlugin.settings.openInMainTab = value;
        await hostPlugin.saveSettings();
      })
    );
}

/**
 * Build the close-time warning shown when the user leaves the settings with a
 * selected provider that can't actually run (no key / no CLI). Returns the
 * notice string, or null when the selected provider IS usable (the happy path
 * stays silent). Pure — reads `plugin.settings` + the readiness kernel, no
 * network, no Notice — so it's unit-testable; the caller (`GryphonSettingTab.
 * hide()`) wraps it in `new Notice(...)`.
 */
function buildProviderUnreadyNotice(plugin) {
  const { describeProviderReadiness, humanizeFailureReason, friendlyProviderLabel } =
    require("@gryphon/provider-runtime");
  const { ready, reason } = describeProviderReadiness(plugin);
  if (ready || !reason) return null;
  const pref = (plugin && plugin.settings && plugin.settings.providerPreference) || "auto";
  const why = humanizeFailureReason(reason);
  if (pref === "auto") {
    return `⚠ Gryphon has no usable provider (${why}). It won't run until you ` +
      `configure one in Settings → Gryphon.`;
  }
  return `⚠ ${friendlyProviderLabel(pref)} — ${why}: it won't be used for your ` +
    `requests. Open Settings → Gryphon to fix it or pick another provider.`;
}

module.exports = {
  renderGryphonSettings,
  buildProviderUnreadyNotice,
  disposeHoverTooltip,
  renderSetupPanel,
  renderFallbackRows,
  renderAdvancedPanel,
  renderDefaultsPanel,
  _credentialFieldsFor,
  renderSectionHeading,
  descToTooltip,
};
