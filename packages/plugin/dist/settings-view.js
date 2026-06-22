"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
const { Setting, Notice, setTooltip } = require("obsidian");
const { MODELS, EFFORTS, PERMS, PROVIDER_PREFS, FALLBACK_PROVIDER_PREFS, resolveConnectionTimeoutMs } = require("./constants");
const { testApiKey: testAnthropicApiKey } = require("../../provider-runtime/src/providers/anthropic-api/anthropic-api");
const { testApiKey: testOpenAIApiKey } = require("../../provider-runtime/src/providers/openai-api/openai-api");
const { testApiKey: testGoogleApiKey } = require("../../provider-runtime/src/providers/google-api/test-key");
const { testCli: testCodexCli } = require("../../provider-runtime/src/providers/codex-cli/test-cli");
const { testCli: testGeminiCli } = require("../../provider-runtime/src/providers/gemini-cli/test-cli");
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
        const { getModelDropdownOptions, DEFAULT_MODEL } = require("@gryphon/provider-runtime").pricing.google;
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
 * Collapse a Setting row's description into Obsidian's native tooltip,
 * attached to an `(i)` info icon appended to the row's name span. Shared by
 * the renderer and (via delegation) by GryphonSettingTab's Gryphon-only zone
 * so the info-icon affordance is consistent across the whole settings tab.
 */
function descToTooltip(setting, tooltipText) {
    if (!setting || !tooltipText)
        return setting;
    setting.setDesc("");
    const info = setting.nameEl.createEl("span", {
        cls: "gryphon-info-icon gryphon-info-icon-inline",
        attr: { tabindex: "0" },
    });
    info.createEl("span", { text: "i", cls: "gryphon-info-icon-glyph" });
    setTooltip(info, tooltipText, { placement: "bottom" });
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
            setTooltip(info, tooltip, { placement: "bottom" });
        }
        return wrap;
    }
    const setting = new Setting(parentEl).setName(title);
    setting.settingEl.classList.add("gryphon-section-heading", "gryphon-section-heading-row");
    if (tooltip)
        descToTooltip(setting, tooltip);
    else
        setting.setDesc("");
    setting.addToggle((toggle) => {
        const current = plugin.settings[toggleKey] !== false;
        toggle.setValue(current).onChange(async (value) => {
            plugin.settings[toggleKey] = !!value;
            await plugin.saveSettings();
            if (onToggle)
                onToggle(!!value);
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
 * @param options     `{ chrome?, onRerender? }`
 *                    - `chrome` (default true): when false, suppress the
 *                      quick-start callout + manual link (the embedded case).
 *                    - `onRerender`: invoked when a change needs a full
 *                      re-render (provider switch rebuilds the model list).
 *                      Defaults to re-empty+re-render of this container.
 */
function renderGryphonSettings(hostPlugin, containerEl, options) {
    options = options || {};
    const chrome = options.chrome !== false;
    const rerender = typeof options.onRerender === "function"
        ? options.onRerender
        : () => {
            containerEl.empty();
            renderGryphonSettings(hostPlugin, containerEl, options);
        };
    if (chrome) {
        // Quick-start callout — surfaces the two setup paths up-front so
        // first-time users don't have to infer them from individual settings.
        const callout = containerEl.createDiv("gryphon-setting-callout");
        callout.createEl("strong", { text: "Quick start: " });
        callout.createSpan({
            text: "Paste an Anthropic API key below to start. Gryphon is not " +
                "affiliated with Anthropic — confirm your intended usage complies " +
                "with Anthropic's Commercial Terms and Acceptable Use Policy. ",
        });
        const manualLink = callout.createEl("a", {
            text: "Open user manual",
            href: "#",
        });
        manualLink.addEventListener("click", (e) => {
            e.preventDefault();
            hostPlugin.app?.workspace?.openLinkText?.("Gryphon/MANUAL", "");
            // Close the settings modal so the manual takes focus
            const settingHost = hostPlugin.app && hostPlugin.app.setting;
            if (settingHost && typeof settingHost.close === "function") {
                settingHost.close();
            }
        });
        callout.createSpan({
            text: " for the full reference (commands, permissions, skills, troubleshooting).",
        });
    }
    renderSectionHeading(containerEl, { title: "Provider" }, hostPlugin);
    // Proactive provider-readiness chip (issue #16). The PRIMARY fix: catches
    // a no-key / unconfigured selected provider BEFORE any request fires — the
    // only surface that warns when a selection is inert (capture/headless
    // paths produce output with no provider request, so no reactive failover
    // notice could ever appear). Readiness is judged by the provider-runtime
    // kernel (the same source createProvider selects from) so the chip can
    // never drift from the real selection logic. `updateProviderStatusChip` is
    // an imperative refresh (NOT a full rerender) so the API-key handlers can
    // re-evaluate without stealing input focus mid-typing.
    let providerStatusEl = null;
    const updateProviderStatusChip = () => {
        if (!providerStatusEl || typeof providerStatusEl.empty !== "function")
            return;
        providerStatusEl.empty();
        const { describeProviderReadiness, humanizeFailureReason } = require("@gryphon/provider-runtime");
        const { ready, reason } = describeProviderReadiness(hostPlugin);
        // Quiet on the happy path — a chip only when the selection won't be used.
        if (!ready && reason && typeof providerStatusEl.createSpan === "function") {
            providerStatusEl.createSpan({
                cls: "gryphon-provider-status-chip",
                text: `⚠ ${humanizeFailureReason(reason)} — won't be used`,
            });
        }
    };
    descToTooltip(new Setting(containerEl).setName("Provider"), "SDK uses the Anthropic API directly (recommended — pay-per-token, " +
        "unambiguously covered by your Anthropic API agreement). CLI spawns " +
        "a locally-installed `claude` binary as a subprocess — confirm your " +
        "usage complies with Anthropic's terms before enabling.")
        .addDropdown((drop) => {
        for (const p of PROVIDER_PREFS)
            drop.addOption(p.value, `${p.label} — ${p.desc}`);
        drop.setValue(hostPlugin.settings.providerPreference || "auto");
        drop.onChange(async (value) => {
            // Issue #29: capture the prior preference BEFORE writing the
            // new value so the announcement message can compare from→to.
            const prevPreference = hostPlugin.settings.providerPreference || "auto";
            hostPlugin.settings.providerPreference = value;
            // When the new provider doesn't recognize the persisted model id
            // (e.g. switching from openai-api → claude-code with model
            // "gpt-5.4-mini"), reset settings.model to a sensible default
            // for the new provider. Without this, the chat-view toolbar
            // shows the stale id as a raw string. Mirrors what the toolbar
            // and Settings dropdown will pick visually so all three surfaces
            // converge before the next render.
            hostPlugin.settings.model = _resetModelForProvider(hostPlugin);
            await hostPlugin.saveSettings();
            hostPlugin._resetActiveSessions?.();
            // Issue #29: tell open chat views that the provider changed
            // so each can flash a one-shot notice naming the new provider
            // + seed-history count. Skipped automatically when there's
            // no prior conversation to forward.
            if (prevPreference !== value) {
                hostPlugin._announceProviderChange?.(prevPreference, value);
            }
            // Bug #22 fix: re-render the Settings tab so the Defaults
            // section (Default model + Default effort) reflects the new
            // Provider. Without this, switching to openai-api leaves
            // "Sonnet — Balanced" stale in the dropdown. The rerender also
            // rebuilds the readiness chip for the newly-selected provider.
            rerender();
        });
    })
        .then((setting) => {
        // Anchor the chip on the Provider row's description element (the same
        // pattern the API-key status lines use). descToTooltip moved the desc
        // text to an info icon, so descEl is ours to own.
        providerStatusEl = setting.descEl;
        updateProviderStatusChip();
    });
    // Fallback provider + model (issue #15). Arms one-hop automatic failover
    // when the active provider can't serve a request for an availability
    // reason. Mirrors the Provider + Default-model dropdown pattern.
    descToTooltip(new Setting(containerEl).setName("Fallback provider"), "When the active provider can't serve a request — no key/CLI, invalid " +
        "key, no credit, quota, or rate-limit — Gryphon retries once with this " +
        "provider and reports which one answered. Genuine content errors never " +
        "trigger failover. 'No fallback' surfaces a clear error instead.")
        .addDropdown((drop) => {
        for (const p of FALLBACK_PROVIDER_PREFS)
            drop.addOption(p.value, `${p.label} — ${p.desc}`);
        drop.setValue(hostPlugin.settings.fallbackProviderPreference || "none");
        drop.onChange(async (value) => {
            hostPlugin.settings.fallbackProviderPreference = value;
            // Reset the fallback model to a sensible default for the new kind so
            // a stale cross-vendor id never lingers. "none"/"auto" carry no
            // single model (auto resolves at runtime).
            if (value === "none" || value === "auto") {
                hostPlugin.settings.fallbackModel = "";
            }
            else {
                const opts = _fallbackModelOptions(value);
                const current = hostPlugin.settings.fallbackModel;
                hostPlugin.settings.fallbackModel =
                    opts.some((o) => o.id === current) ? current : (opts[0] ? opts[0].id : "");
            }
            await hostPlugin.saveSettings();
            // Re-render so the Fallback-model row appears/updates for the new kind.
            rerender();
        });
    });
    // Fallback model — only meaningful for an explicit fallback provider
    // ("none" has no model; "auto" resolves the model at runtime).
    const fbPref = hostPlugin.settings.fallbackProviderPreference || "none";
    if (fbPref !== "none" && fbPref !== "auto") {
        const fbModels = _fallbackModelOptions(fbPref);
        // Auto-correct a stale persisted fallbackModel so the dropdown and the
        // runtime resolver agree (same pattern as the Default-model rows below).
        if (fbModels.length && !fbModels.some((o) => o.id === hostPlugin.settings.fallbackModel)) {
            hostPlugin.settings.fallbackModel = fbModels[0].id;
            hostPlugin.saveSettings();
        }
        new Setting(containerEl)
            .setName("Fallback model")
            .addDropdown((drop) => {
            for (const m of fbModels)
                drop.addOption(m.id, m.label);
            drop.setValue(hostPlugin.settings.fallbackModel || (fbModels[0] && fbModels[0].id) || "");
            drop.onChange(async (value) => {
                hostPlugin.settings.fallbackModel = value;
                await hostPlugin.saveSettings();
            });
        });
    }
    // Claude CLI path + inline detection status. Status badge
    // renders next to the row label (not on its own line below the
    // Setting) to save vertical space. For "Not detected" we swap
    // out the tooltip content with the install-guidance details
    // rather than inflating the visible row.
    const cliSetting = descToTooltip(new Setting(containerEl).setName("Claude Code path"), "Leave empty for auto-detect (checks common locations + your " +
        "login-shell PATH). Used in Claude Code mode only.");
    // Status pill that renders inline in the name area.
    const cliStatusPill = cliSetting.nameEl.createEl("span", {
        cls: "gryphon-cli-status-pill",
    });
    const renderCliStatus = () => {
        cliStatusPill.empty();
        cliStatusPill.className = "gryphon-cli-status-pill";
        const manualPath = (hostPlugin.settings.claudePath || "").trim();
        const { findClaudeBinary, detectFlatpakSandbox, displayPath } = require("@gryphon/provider-runtime");
        const flatpak = detectFlatpakSandbox();
        const detected = manualPath || findClaudeBinary();
        if (detected) {
            cliStatusPill.addClass("is-ok");
            // Collapse home-dir prefix so the visible pill never leaks the
            // OS username (screenshots, demos, screen-shared Settings).
            const shown = displayPath(detected);
            cliStatusPill.setText(`✓ ${shown}`);
            setTooltip(cliStatusPill, `Claude CLI detected at:\n${shown}`, { placement: "bottom" });
        }
        else if (flatpak.isFlatpak) {
            cliStatusPill.addClass("is-warn");
            cliStatusPill.setText("⚠ Not detected (Flatpak sandbox)");
            setTooltip(cliStatusPill, `Obsidian is running in a Flatpak sandbox (${flatpak.appId}) ` +
                `which can't see /usr/bin. Fix:\n\n` +
                `• Install claude under $HOME:\n` +
                `    npm config set prefix ~/.npm-global\n` +
                `    npm install -g @anthropic-ai/claude-code\n\n` +
                `• OR grant sandbox access:\n` +
                `    flatpak override --user --filesystem=/usr:ro ${flatpak.appId}\n\n` +
                `Then restart Obsidian.`, { placement: "bottom" });
        }
        else {
            cliStatusPill.addClass("is-warn");
            cliStatusPill.setText("⚠ Not detected");
            setTooltip(cliStatusPill, "Gryphon checked common install locations and your login-shell " +
                "PATH. Install claude (npm / brew / apt) and restart Obsidian, " +
                "or set the full path in the field on the right if it's already " +
                "installed in a non-standard location.", { placement: "bottom" });
        }
    };
    cliSetting
        .addText((text) => {
        const { findClaudeBinary, displayPath } = require("@gryphon/provider-runtime");
        const detected = findClaudeBinary();
        return text
            .setPlaceholder(detected ? displayPath(detected) : "/usr/local/bin/claude")
            .setValue(hostPlugin.settings.claudePath)
            .onChange(async (value) => {
            hostPlugin.settings.claudePath = value;
            await hostPlugin.saveSettings();
            hostPlugin._resetActiveSessions?.();
            renderCliStatus();
        });
    })
        .addButton((btn) => btn
        .setButtonText("Re-detect")
        .setTooltip("Clear the discovery cache and probe again")
        .onClick(() => {
        const { clearBinaryDiscoveryCache } = require("@gryphon/provider-runtime");
        clearBinaryDiscoveryCache();
        renderCliStatus();
    }));
    renderCliStatus();
    let keyStatusEl = null;
    descToTooltip(new Setting(containerEl).setName("Anthropic API key"), "Required for Anthropic API mode. Paste your key here — stored in plugin " +
        "data.json. (Advanced: ANTHROPIC_API_KEY env var also works, but " +
        "only if Obsidian was launched from a shell that has the variable. " +
        "macOS GUI launches via Finder/Dock/Spotlight do NOT see ~/.zshrc " +
        "env vars.)")
        .addText((text) => {
        text.inputEl.type = "password";
        text
            .setPlaceholder("sk-ant-...")
            .setValue(hostPlugin.settings.anthropicApiKey || "")
            .onChange(async (value) => {
            hostPlugin.settings.anthropicApiKey = value.trim();
            await hostPlugin.saveSettings();
            hostPlugin._resetActiveSessions?.();
            if (keyStatusEl)
                keyStatusEl.setText("");
            // Refresh the readiness chip (issue #16) without a full rerender,
            // so typing a key clears the warning mid-edit without losing focus.
            updateProviderStatusChip();
        });
    })
        .addButton((btn) => btn
        .setButtonText("Test key")
        .onClick(async () => {
        btn.setDisabled(true).setButtonText("Testing...");
        const key = (hostPlugin.settings.anthropicApiKey || "").trim() ||
            process.env.ANTHROPIC_API_KEY ||
            "";
        const { ok, message } = await testAnthropicApiKey(key);
        btn.setDisabled(false).setButtonText("Test key");
        if (keyStatusEl) {
            keyStatusEl.setText(ok ? `✓ ${message}` : `✗ ${message}`);
            keyStatusEl.style.color = ok ? "var(--color-green)" : "var(--color-red)";
        }
        new Notice(`Anthropic API key: ${ok ? "OK" : message}`);
    }))
        .then((setting) => {
        keyStatusEl = setting.descEl.createDiv({ cls: "setting-item-description" });
        keyStatusEl.setCssStyles({ marginTop: "4px" });
    });
    // OpenAI + Google API keys (v1.2.0 — per ADR 0003). OpenAI adapter
    // shipped in Stage 2 (#17); Google adapter lands in Stage 3 (#18).
    // The Test-key buttons mirror the Anthropic pattern above — they
    // make a no-token-cost validation call so users can verify before
    // running an actual chat turn.
    let openaiKeyStatusEl = null;
    descToTooltip(new Setting(containerEl).setName("OpenAI API key"), "Required for OpenAI API mode (v1.2.0). Paste your key here — " +
        "stored in plugin data.json. (Advanced: OPENAI_API_KEY env var " +
        "also works, but only if Obsidian was launched from a shell that " +
        "has the variable.)")
        .addText((text) => {
        text.inputEl.type = "password";
        text
            .setPlaceholder("sk-...")
            .setValue(hostPlugin.settings.openaiApiKey || "")
            .onChange(async (value) => {
            hostPlugin.settings.openaiApiKey = value.trim();
            await hostPlugin.saveSettings();
            hostPlugin._resetActiveSessions?.();
            if (openaiKeyStatusEl)
                openaiKeyStatusEl.setText("");
            updateProviderStatusChip();
        });
    })
        .addButton((btn) => btn
        .setButtonText("Test key")
        .onClick(async () => {
        btn.setDisabled(true).setButtonText("Testing...");
        const key = (hostPlugin.settings.openaiApiKey || "").trim() ||
            process.env.OPENAI_API_KEY ||
            "";
        const { ok, message } = await testOpenAIApiKey(key);
        btn.setDisabled(false).setButtonText("Test key");
        if (openaiKeyStatusEl) {
            openaiKeyStatusEl.setText(ok ? `✓ ${message}` : `✗ ${message}`);
            openaiKeyStatusEl.style.color = ok ? "var(--color-green)" : "var(--color-red)";
        }
        new Notice(`OpenAI API key: ${ok ? "OK" : message}`);
    }))
        .then((setting) => {
        openaiKeyStatusEl = setting.descEl.createDiv({ cls: "setting-item-description" });
        openaiKeyStatusEl.setCssStyles({ marginTop: "4px" });
    });
    let googleKeyStatusEl = null;
    descToTooltip(new Setting(containerEl).setName("Google API key"), "Required for Google Gemini API mode (v1.2.0). Paste your key " +
        "here — stored in plugin data.json. Get one free at " +
        "aistudio.google.com/apikey. (Advanced: GOOGLE_API_KEY env var " +
        "also works, but only if Obsidian was launched from a shell that " +
        "has the variable.)")
        .addText((text) => {
        text.inputEl.type = "password";
        text
            .setPlaceholder("AIza...")
            .setValue(hostPlugin.settings.googleApiKey || "")
            .onChange(async (value) => {
            hostPlugin.settings.googleApiKey = value.trim();
            await hostPlugin.saveSettings();
            hostPlugin._resetActiveSessions?.();
            if (googleKeyStatusEl)
                googleKeyStatusEl.setText("");
            updateProviderStatusChip();
        });
    })
        .addButton((btn) => btn
        .setButtonText("Test key")
        .onClick(async () => {
        btn.setDisabled(true).setButtonText("Testing...");
        const key = (hostPlugin.settings.googleApiKey || "").trim() ||
            process.env.GOOGLE_API_KEY ||
            "";
        const { ok, message } = await testGoogleApiKey(key, hostPlugin.hostAdapter);
        btn.setDisabled(false).setButtonText("Test key");
        if (googleKeyStatusEl) {
            googleKeyStatusEl.setText(ok ? `✓ ${message}` : `✗ ${message}`);
            googleKeyStatusEl.style.color = ok ? "var(--color-green)" : "var(--color-red)";
        }
        new Notice(`Google API key: ${ok ? "OK" : message}`);
    }))
        .then((setting) => {
        googleKeyStatusEl = setting.descEl.createDiv({ cls: "setting-item-description" });
        googleKeyStatusEl.setCssStyles({ marginTop: "4px" });
    });
    // Codex CLI + Gemini CLI binary path settings (v1.3 — codex-cli /
    // gemini-cli modes). Symmetric with the Claude Code path field
    // above. Test buttons run `<bin> --version` to verify the binary
    // works without burning credits.
    let codexStatusEl = null;
    descToTooltip(new Setting(containerEl).setName("Codex CLI path"), "Optional. Required only when Provider is Codex CLI. Empty string " +
        "auto-detects: macOS checks /Applications/Codex.app/Contents/Resources/codex " +
        "first, then PATH and common bin directories. Auth is handled by the " +
        "CLI itself — run `codex login` in a terminal once after installing.")
        .addText((text) => {
        const { findCodexBinary, displayPath } = require("@gryphon/provider-runtime");
        const detected = findCodexBinary();
        return text
            .setPlaceholder(detected
            ? displayPath(detected)
            : "/Applications/Codex.app/Contents/Resources/codex")
            .setValue(hostPlugin.settings.codexPath || "")
            .onChange(async (value) => {
            hostPlugin.settings.codexPath = value.trim();
            await hostPlugin.saveSettings();
            hostPlugin._resetActiveSessions?.();
            if (codexStatusEl)
                codexStatusEl.setText("");
        });
    })
        .addButton((btn) => btn
        .setButtonText("Test CLI")
        .onClick(async () => {
        btn.setDisabled(true).setButtonText("Testing...");
        const { findCodexBinary } = require("@gryphon/provider-runtime");
        const codexPath = (hostPlugin.settings.codexPath || "").trim() ||
            findCodexBinary() ||
            "";
        const { ok, message } = await testCodexCli(codexPath);
        btn.setDisabled(false).setButtonText("Test CLI");
        if (codexStatusEl) {
            codexStatusEl.setText(ok ? `✓ ${message}` : `✗ ${message}`);
            codexStatusEl.style.color = ok ? "var(--color-green)" : "var(--color-red)";
        }
        new Notice(`Codex CLI: ${ok ? "OK" : message}`);
    }))
        .then((setting) => {
        codexStatusEl = setting.descEl.createDiv({ cls: "setting-item-description" });
        codexStatusEl.setCssStyles({ marginTop: "4px" });
    });
    let geminiCliStatusEl = null;
    descToTooltip(new Setting(containerEl).setName("Gemini CLI path"), "Optional. Required only when Provider is Gemini CLI. Empty string " +
        "auto-detects via PATH and common bin directories. Auth uses the " +
        "Google API key field above (forwarded as GEMINI_API_KEY env var " +
        "to the CLI).")
        .addText((text) => {
        const { findGeminiBinary, displayPath } = require("@gryphon/provider-runtime");
        const detected = findGeminiBinary();
        return text
            .setPlaceholder(detected ? displayPath(detected) : "/opt/homebrew/bin/gemini")
            .setValue(hostPlugin.settings.geminiCliPath || "")
            .onChange(async (value) => {
            hostPlugin.settings.geminiCliPath = value.trim();
            await hostPlugin.saveSettings();
            hostPlugin._resetActiveSessions?.();
            if (geminiCliStatusEl)
                geminiCliStatusEl.setText("");
        });
    })
        .addButton((btn) => btn
        .setButtonText("Test CLI")
        .onClick(async () => {
        btn.setDisabled(true).setButtonText("Testing...");
        const { findGeminiBinary } = require("@gryphon/provider-runtime");
        const geminiPath = (hostPlugin.settings.geminiCliPath || "").trim() ||
            findGeminiBinary() ||
            "";
        const { ok, message } = await testGeminiCli(geminiPath);
        btn.setDisabled(false).setButtonText("Test CLI");
        if (geminiCliStatusEl) {
            geminiCliStatusEl.setText(ok ? `✓ ${message}` : `✗ ${message}`);
            geminiCliStatusEl.style.color = ok ? "var(--color-green)" : "var(--color-red)";
        }
        new Notice(`Gemini CLI: ${ok ? "OK" : message}`);
    }))
        .then((setting) => {
        geminiCliStatusEl = setting.descEl.createDiv({ cls: "setting-item-description" });
        geminiCliStatusEl.setCssStyles({ marginTop: "4px" });
    });
    descToTooltip(new Setting(containerEl).setName("Brave Search API key"), "Optional. Enables SDK-mode WebSearch. Free at brave.com/search/api/ " +
        "(2000 queries/month). Claude Code mode uses Anthropic's built-in search and " +
        "ignores this.")
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
    descToTooltip(new Setting(containerEl).setName("Auto-compact at 95% (SDK mode)"), "Automatically summarize and reset the conversation when context " +
        "fills up. Disable to get an explicit \"context full\" warning at " +
        "95% and run /compact manually instead. Claude Code mode handles " +
        "its own auto-compaction and ignores this.")
        .addToggle((toggle) => toggle.setValue(hostPlugin.settings.autoCompactSdk !== false).onChange(async (value) => {
        hostPlugin.settings.autoCompactSdk = value;
        await hostPlugin.saveSettings();
    }));
    // Issue #34 deferred: opt-in auto-retry on rate-limit. Off by
    // default — automatic retries can pile up unintended cost on
    // metered APIs. When on, a single retry fires after the parsed
    // retry-after window (capped at 60s); a second 429 does not chain.
    descToTooltip(new Setting(containerEl).setName("Auto-retry on rate-limit"), "When a send fails with a rate-limit error and the response " +
        "includes a precise retry-after delay (≤60s), Gryphon will " +
        "automatically resubmit your prompt once after the window expires. " +
        "If turned off, your prompt is preserved in the input box and " +
        "you press Send manually when ready. Per-day quota errors are " +
        "never auto-retried.")
        .addToggle((toggle) => toggle.setValue(hostPlugin.settings.autoRetryOnRateLimit === true).onChange(async (value) => {
        hostPlugin.settings.autoRetryOnRateLimit = value;
        await hostPlugin.saveSettings();
    }));
    // v1.7.0 F1 — opt-out for SDK-mode authoritative token counting.
    // Anthropic's `messages.countTokens` endpoint is free (no charge,
    // no generation) and gives an exact pre-send token count. Default
    // on. Users who prefer zero "background" network activity can
    // disable; the heuristic estimator handles both CLI mode and the
    // SDK-disabled path.
    descToTooltip(new Setting(containerEl).setName("Use exact token counts (SDK mode)"), "When using the Anthropic API provider, Gryphon calls the free " +
        "messages.countTokens endpoint on debounced typing pauses to show " +
        "an exact projected context size before send. Anthropic does not " +
        "charge for this endpoint. Disable to keep all pre-send context " +
        "computation strictly local (the heuristic estimator is used as " +
        "the fallback). CLI providers (claude-code / codex-cli / gemini-cli) " +
        "are unaffected — they always use the local heuristic.")
        .addToggle((toggle) => toggle.setValue(hostPlugin.settings.useExactTokenCounting !== false).onChange(async (value) => {
        hostPlugin.settings.useExactTokenCounting = value;
        await hostPlugin.saveSettings();
    }));
    // v1.7.0 F1 — confirm modal when projected context is ≥95% of the
    // model's window. Default on. Users who push the limit on purpose
    // (one-shot long-context prompts where they know what they're doing)
    // can disable so the modal doesn't get in the way.
    descToTooltip(new Setting(containerEl).setName("Confirm before overflow sends"), "When the projected context for the next send is at or above " +
        "95% of the model's window, Gryphon shows a confirmation modal " +
        "with recovery suggestions (switch model / /compact / /clear). " +
        "Disable to send without confirmation even when overflow is likely.")
        .addToggle((toggle) => toggle.setValue(hostPlugin.settings.confirmOnContextOverflow !== false).onChange(async (value) => {
        hostPlugin.settings.confirmOnContextOverflow = value;
        await hostPlugin.saveSettings();
    }));
    // v1.7.0 F4 — Obsidian REST API access policy. Blocks claude-code's
    // built-in WebFetch from reaching the obsidian-local-rest-api
    // plugin on loopback (127.0.0.1:27124). Default blocked because
    // unrestricted access has been seen producing 500+ enumeration GETs
    // per question when vault-native search would close it in one call.
    // Users who actually want REST integration can flip this on per
    // session via the chat toolbar chip; the setting here defines the
    // start-of-session default.
    descToTooltip(new Setting(containerEl).setName("Block Obsidian REST API access"), "When on (default), Gryphon denies WebFetch calls to the Obsidian " +
        "REST API plugin on loopback. This prevents the language model " +
        "from enumerating the vault via REST when a single grep would " +
        "answer the same question. Turn off to let the model reach " +
        "127.0.0.1:27124 freely; a warning toast still fires when GETs " +
        "exceed the threshold below in one turn.")
        .addToggle((toggle) => toggle.setValue((hostPlugin.settings.obsidianRestApiPolicy || "blocked") === "blocked").onChange(async (value) => {
        hostPlugin.settings.obsidianRestApiPolicy = value ? "blocked" : "allowed";
        await hostPlugin.saveSettings();
        try {
            // Preserve the cross-plugin contract: consumers listen on this
            // event for live provider/model teardown (Gryphon 2.4.4). Guard
            // the whole chain so a minimal host without app/workspace is safe.
            hostPlugin.app?.workspace?.trigger?.("gryphon:settings-changed");
        }
        catch { /* best-effort */ }
    }));
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
        if (!timeoutStatusEl)
            return;
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
        }
        else {
            const sec = Number(trimmed);
            if (Number.isFinite(sec) && sec >= 5 && sec <= 600) {
                prefix = `✓ Override active: ${effectiveSec}s`;
                color = "var(--color-green)";
            }
            else {
                prefix = `✗ Invalid: must be 5–600 seconds. Currently using: ${effectiveSec}s`;
                color = "var(--color-red)";
            }
        }
        timeoutStatusEl.setText(prefix);
        timeoutStatusEl.style.color = color;
    };
    descToTooltip(new Setting(containerEl).setName("Connection timeout (seconds)"), "How long to wait for the model's first token before treating " +
        "the request as stuck. Leave empty for the model-adaptive " +
        "default (Haiku 30s, Sonnet 60s, Opus 120s, Opus 1M 180s; " +
        "non-Anthropic providers 60s). Set 5–600 to override for slow " +
        "networks or unusually large prompts.")
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
    renderSectionHeading(containerEl, { title: "Defaults" }, hostPlugin);
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
        const { getModelDropdownOptions: getGeminiOptions, resolveModel: resolveGeminiModel, DEFAULT_MODEL: GEMINI_DEFAULT_MODEL, } = require("@gryphon/provider-runtime").pricing.google;
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
        new Setting(containerEl)
            .setName("Default model")
            .addDropdown((drop) => {
            for (const m of geminiModels)
                drop.addOption(m.id, m.label);
            drop.setValue(hostPlugin.settings.model);
            drop.onChange(async (value) => {
                hostPlugin.settings.model = value;
                await hostPlugin.saveSettings();
                hostPlugin._resetActiveSessions?.();
            });
        });
        new Setting(containerEl)
            .setName("Default effort")
            .addDropdown((drop) => {
            for (const e of EFFORTS)
                drop.addOption(e.value, `${e.label} — ${e.desc}`);
            drop.setValue(hostPlugin.settings.effort);
            drop.onChange(async (value) => {
                hostPlugin.settings.effort = value;
                await hostPlugin.saveSettings();
                hostPlugin._resetActiveSessions?.();
            });
        });
    }
    else if (activePref === "openai-api" || activePref === "codex-cli") {
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
        new Setting(containerEl)
            .setName("Default model")
            .addDropdown((drop) => {
            for (const m of openaiModels)
                drop.addOption(m.id, m.label);
            drop.setValue(hostPlugin.settings.model);
            drop.onChange(async (value) => {
                hostPlugin.settings.model = value;
                await hostPlugin.saveSettings();
                hostPlugin._resetActiveSessions?.();
            });
        });
        new Setting(containerEl)
            .setName("Default effort")
            .addDropdown((drop) => {
            for (const e of EFFORTS)
                drop.addOption(e.value, `${e.label} — ${e.desc}`);
            drop.setValue(hostPlugin.settings.effort);
            drop.onChange(async (value) => {
                hostPlugin.settings.effort = value;
                await hostPlugin.saveSettings();
                hostPlugin._resetActiveSessions?.();
            });
        });
    }
    else {
        new Setting(containerEl)
            .setName("Default model")
            .addDropdown((drop) => {
            for (const m of MODELS)
                drop.addOption(m.value, `${m.label} — ${m.desc}`);
            drop.setValue(hostPlugin.settings.model);
            drop.onChange(async (value) => {
                hostPlugin.settings.model = value;
                await hostPlugin.saveSettings();
                hostPlugin._resetActiveSessions?.();
            });
        });
        new Setting(containerEl)
            .setName("Default effort")
            .addDropdown((drop) => {
            for (const e of EFFORTS)
                drop.addOption(e.value, `${e.label} — ${e.desc}`);
            drop.setValue(hostPlugin.settings.effort);
            drop.onChange(async (value) => {
                hostPlugin.settings.effort = value;
                await hostPlugin.saveSettings();
                hostPlugin._resetActiveSessions?.();
            });
        });
    }
    new Setting(containerEl)
        .setName("Default permissions")
        .addDropdown((drop) => {
        for (const p of PERMS)
            drop.addOption(p.value, `${p.label} — ${p.desc}`);
        drop.setValue(hostPlugin.settings.permissionMode);
        drop.onChange(async (value) => {
            hostPlugin.settings.permissionMode = value;
            await hostPlugin.saveSettings();
            hostPlugin._resetActiveSessions?.();
        });
    });
    descToTooltip(new Setting(containerEl).setName("Open in main tab"), "Open chat in the main editor area instead of the sidebar " +
        "(takes effect next time the chat is opened).")
        .addToggle((toggle) => toggle.setValue(hostPlugin.settings.openInMainTab).onChange(async (value) => {
        hostPlugin.settings.openInMainTab = value;
        await hostPlugin.saveSettings();
    }));
    descToTooltip(new Setting(containerEl).setName("Max file size (MB)"), "Upper bound on the size of a single file that Read or Edit " +
        "will load. Larger files are refused with a pointer to " +
        "offset/limit or Grep. Default 10 MB — raise with caution; " +
        "very large files can slow Obsidian.")
        .addText((text) => text
        .setPlaceholder("10")
        .setValue(String(hostPlugin.settings.maxReadFileSizeMb ?? 10))
        .onChange(async (value) => {
        const n = Number(value);
        if (Number.isFinite(n) && n > 0) {
            hostPlugin.settings.maxReadFileSizeMb = n;
            await hostPlugin.saveSettings();
        }
    }));
}
module.exports = {
    renderGryphonSettings,
    renderSectionHeading,
    descToTooltip,
};
