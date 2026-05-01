/**
 * Gryphon — Claude chat for Obsidian.
 *
 * Standalone chat plugin. No knowledge base, no ingest pipeline, no MCP
 * tools. Just a conversation with Claude (via the Anthropic API or an
 * optional locally-installed Claude CLI) that can read/edit vault files
 * and use the standard chat tools.
 */

const { Plugin, PluginSettingTab, Setting, Notice, Modal, setTooltip } = require("obsidian");
const path = require("path");
const { GryphonChatView } = require("./chat-view");
const { DEFAULT_SETTINGS, MODELS, EFFORTS, PERMS, PROVIDER_PREFS, DEFAULT_PROTECTED_PATHS, DEFAULT_PROTECTED_COMMANDS } = require("./constants");
const { SkillRegistry } = require("./skills");
const { testApiKey } = require("./providers/anthropic-api/anthropic-api");
const {
  PermissionIPCServer,
  defaultSocketPath,
} = require("./providers/shared/permission-ipc-server");
const attackDetector = require("./providers/shared/attack-detector");
const { ProvenanceStore } = require("./providers/shared/provenance-store");
const { sweepGryphonOrphans } = require("./providers/shared/tmpfile-sweeper");

const VIEW_TYPE = "gryphon-view";

/**
 * Format a provenance `taggedAt` ISO-8601 timestamp for user-facing
 * display. The on-disk value is UTC ("Z" suffix) so the store stays
 * portable across timezone changes — but rendering raw UTC is
 * unfriendly when the user is in (say) Pacific time and sees
 * something that looks 7 hours off. Use the browser's locale-aware
 * formatting so the displayed value matches the user's clock.
 *
 * Falls back to the raw string if the value isn't parseable (e.g. a
 * hand-edited provenance.json with a non-ISO timestamp).
 */
function _formatTaggedAt(iso) {
  if (!iso || typeof iso !== "string") return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  // `sv-SE` locale renders as "YYYY-MM-DD HH:MM:SS" (ISO-like but with
  // a space instead of 'T') which is the most readable form that
  // still sorts correctly as a string in the modal table.
  try {
    return d.toLocaleString("sv-SE");
  } catch (_) {
    // Fallback — extremely rare (Intl unavailable). Strip ms + Z so
    // the output at least doesn't show microsecond noise.
    return iso.replace("T", " ").replace(/\..+$/, "");
  }
}

/**
 * Derive modal-friendly `action` / `target` strings from a tool-use
 * payload. Used by the IPC `classify` handler so CLI-mode modals read
 * the same as SDK-mode modals.
 */
function _deriveActionTarget(tool, input) {
  if (tool === "Write") return { action: "write", target: input.file_path || "?" };
  if (tool === "Edit") return { action: "edit", target: input.file_path || "?" };
  // Both Bash (POSIX) and PowerShell (Windows) are shell-exec tools
  // with a `command` string and need the same modal wording.
  if (tool === "Bash" || tool === "PowerShell") {
    const cmd = typeof input.command === "string" ? input.command : "";
    const preview = cmd.length > 80 ? cmd.slice(0, 77) + "..." : cmd;
    return { action: "run", target: preview || "(empty command)" };
  }
  return { action: tool.toLowerCase(), target: JSON.stringify(input).slice(0, 80) };
}

class GryphonSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    // Round-8 F7: stash a reference so non-settings callers (e.g. the
    // post-clear-provenance flow) can call display() to refresh the
    // visible tab content. PluginSettingTab instances aren't workspace
    // leaves so getActiveViewOfType doesn't return them — this is the
    // simplest correct hook.
    this.plugin._activeSettingTab = this;
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Gryphon Settings" });

    // Quick-start callout — surfaces the two setup paths up-front so
    // first-time users don't have to infer them from individual settings.
    const callout = containerEl.createDiv("gryphon-setting-callout");
    callout.createEl("strong", { text: "Quick start: " });
    callout.createSpan({
      text:
        "Paste an Anthropic API key below to start. Gryphon is not " +
        "affiliated with Anthropic — confirm your intended usage complies " +
        "with Anthropic's Commercial Terms and Acceptable Use Policy. ",
    });
    const manualLink = callout.createEl("a", {
      text: "Open user manual",
      href: "#",
    });
    manualLink.addEventListener("click", (e) => {
      e.preventDefault();
      this.app.workspace.openLinkText("Gryphon/MANUAL", "");
      // Close the settings modal so the manual takes focus
      if (this.app.setting && typeof this.app.setting.close === "function") {
        this.app.setting.close();
      }
    });
    callout.createSpan({
      text: " for the full reference (commands, permissions, skills, troubleshooting).",
    });

    this._renderSectionHeading(containerEl, { title: "Provider" });

    this._descToTooltip(
      new Setting(containerEl).setName("Provider"),
      "SDK uses the Anthropic API directly (recommended — pay-per-token, " +
      "unambiguously covered by your Anthropic API agreement). CLI spawns " +
      "a locally-installed `claude` binary as a subprocess — confirm your " +
      "usage complies with Anthropic's terms before enabling.",
    )
      .addDropdown((drop) => {
        for (const p of PROVIDER_PREFS) drop.addOption(p.value, `${p.label} — ${p.desc}`);
        drop.setValue(this.plugin.settings.providerPreference || "auto");
        drop.onChange(async (value) => {
          this.plugin.settings.providerPreference = value;
          await this.plugin.saveSettings();
          this.plugin._resetActiveSessions();
        });
      });

    // Claude CLI path + inline detection status. Status badge
    // renders next to the row label (not on its own line below the
    // Setting) to save vertical space. For "Not detected" we swap
    // out the tooltip content with the install-guidance details
    // rather than inflating the visible row.
    const cliSetting = this._descToTooltip(
      new Setting(containerEl).setName("Claude Code path"),
      "Leave empty for auto-detect (checks common locations + your " +
      "login-shell PATH). Used in Claude Code mode only.",
    );
    // Status pill that renders inline in the name area.
    const cliStatusPill = cliSetting.nameEl.createEl("span", {
      cls: "gryphon-cli-status-pill",
    });

    const renderCliStatus = () => {
      cliStatusPill.empty();
      cliStatusPill.className = "gryphon-cli-status-pill";
      const manualPath = (this.plugin.settings.claudePath || "").trim();
      const { findClaudeBinary, detectFlatpakSandbox, displayPath } = require("./utils");
      const flatpak = detectFlatpakSandbox();
      const detected = manualPath || findClaudeBinary();
      if (detected) {
        cliStatusPill.addClass("is-ok");
        // Collapse home-dir prefix so the visible pill never leaks the
        // OS username (screenshots, demos, screen-shared Settings).
        const shown = displayPath(detected);
        cliStatusPill.setText(`✓ ${shown}`);
        setTooltip(cliStatusPill, `Claude CLI detected at:\n${shown}`, { placement: "bottom" });
      } else if (flatpak.isFlatpak) {
        cliStatusPill.addClass("is-warn");
        cliStatusPill.setText("⚠ Not detected (Flatpak sandbox)");
        setTooltip(
          cliStatusPill,
          `Obsidian is running in a Flatpak sandbox (${flatpak.appId}) ` +
          `which can't see /usr/bin. Fix:\n\n` +
          `• Install claude under $HOME:\n` +
          `    npm config set prefix ~/.npm-global\n` +
          `    npm install -g @anthropic-ai/claude-code\n\n` +
          `• OR grant sandbox access:\n` +
          `    flatpak override --user --filesystem=/usr:ro ${flatpak.appId}\n\n` +
          `Then restart Obsidian.`,
          { placement: "bottom" },
        );
      } else {
        cliStatusPill.addClass("is-warn");
        cliStatusPill.setText("⚠ Not detected");
        setTooltip(
          cliStatusPill,
          "Gryphon checked common install locations and your login-shell " +
          "PATH. Install claude (npm / brew / apt) and restart Obsidian, " +
          "or set the full path in the field on the right if it's already " +
          "installed in a non-standard location.",
          { placement: "bottom" },
        );
      }
    };

    cliSetting
      .addText((text) => {
        const { findClaudeBinary, displayPath } = require("./utils");
        const detected = findClaudeBinary();
        return text
          .setPlaceholder(detected ? displayPath(detected) : "/usr/local/bin/claude")
          .setValue(this.plugin.settings.claudePath)
          .onChange(async (value) => {
            this.plugin.settings.claudePath = value;
            await this.plugin.saveSettings();
            this.plugin._resetActiveSessions();
            renderCliStatus();
          });
      })
      .addButton((btn) =>
        btn
          .setButtonText("Re-detect")
          .setTooltip("Clear the discovery cache and probe again")
          .onClick(() => {
            const { clearBinaryDiscoveryCache } = require("./utils");
            clearBinaryDiscoveryCache();
            renderCliStatus();
          }),
      );
    renderCliStatus();

    let keyStatusEl = null;
    this._descToTooltip(
      new Setting(containerEl).setName("Anthropic API key"),
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
          .setValue(this.plugin.settings.anthropicApiKey || "")
          .onChange(async (value) => {
            this.plugin.settings.anthropicApiKey = value.trim();
            await this.plugin.saveSettings();
            this.plugin._resetActiveSessions();
            if (keyStatusEl) keyStatusEl.setText("");
          });
      })
      .addButton((btn) =>
        btn
          .setButtonText("Test key")
          .onClick(async () => {
            btn.setDisabled(true).setButtonText("Testing...");
            const key =
              (this.plugin.settings.anthropicApiKey || "").trim() ||
              process.env.ANTHROPIC_API_KEY ||
              "";
            const { ok, message } = await testApiKey(key);
            btn.setDisabled(false).setButtonText("Test key");
            if (keyStatusEl) {
              keyStatusEl.setText(ok ? `✓ ${message}` : `✗ ${message}`);
              keyStatusEl.style.color = ok ? "var(--color-green)" : "var(--color-red)";
            }
            new Notice(`Anthropic API key: ${ok ? "OK" : message}`);
          })
      )
      .then((setting) => {
        keyStatusEl = setting.descEl.createDiv({ cls: "setting-item-description" });
        keyStatusEl.style.marginTop = "4px";
      });

    this._descToTooltip(
      new Setting(containerEl).setName("Brave Search API key"),
      "Optional. Enables SDK-mode WebSearch. Free at brave.com/search/api/ " +
      "(2000 queries/month). Claude Code mode uses Anthropic's built-in search and " +
      "ignores this.",
    )
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("BSA...")
          .setValue(this.plugin.settings.braveSearchApiKey || "")
          .onChange(async (value) => {
            this.plugin.settings.braveSearchApiKey = value.trim();
            await this.plugin.saveSettings();
            this.plugin._resetActiveSessions();
          });
      });

    this._descToTooltip(
      new Setting(containerEl).setName("Auto-compact at 95% (SDK mode)"),
      "Automatically summarize and reset the conversation when context " +
      "fills up. Disable to get an explicit \"context full\" warning at " +
      "95% and run /compact manually instead. Claude Code mode handles " +
      "its own auto-compaction and ignores this.",
    )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoCompactSdk !== false).onChange(async (value) => {
          this.plugin.settings.autoCompactSdk = value;
          await this.plugin.saveSettings();
        })
      );

    this._renderSectionHeading(containerEl, { title: "Defaults" });

    new Setting(containerEl)
      .setName("Default model")
      .addDropdown((drop) => {
        for (const m of MODELS) drop.addOption(m.value, `${m.label} — ${m.desc}`);
        drop.setValue(this.plugin.settings.model);
        drop.onChange(async (value) => {
          this.plugin.settings.model = value;
          await this.plugin.saveSettings();
          this.plugin._resetActiveSessions();
        });
      });

    new Setting(containerEl)
      .setName("Default effort")
      .addDropdown((drop) => {
        for (const e of EFFORTS) drop.addOption(e.value, `${e.label} — ${e.desc}`);
        drop.setValue(this.plugin.settings.effort);
        drop.onChange(async (value) => {
          this.plugin.settings.effort = value;
          await this.plugin.saveSettings();
          this.plugin._resetActiveSessions();
        });
      });

    new Setting(containerEl)
      .setName("Default permissions")
      .addDropdown((drop) => {
        for (const p of PERMS) drop.addOption(p.value, `${p.label} — ${p.desc}`);
        drop.setValue(this.plugin.settings.permissionMode);
        drop.onChange(async (value) => {
          this.plugin.settings.permissionMode = value;
          await this.plugin.saveSettings();
          this.plugin._resetActiveSessions();
        });
      });

    this._descToTooltip(
      new Setting(containerEl).setName("Open in main tab"),
      "Open chat in the main editor area instead of the sidebar " +
      "(takes effect next time the chat is opened).",
    )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.openInMainTab).onChange(async (value) => {
          this.plugin.settings.openInMainTab = value;
          await this.plugin.saveSettings();
        })
      );

    this._descToTooltip(
      new Setting(containerEl).setName("Max file size (MB)"),
      "Upper bound on the size of a single file that Read or Edit " +
      "will load. Larger files are refused with a pointer to " +
      "offset/limit or Grep. Default 10 MB — raise with caution; " +
      "very large files can slow Obsidian.",
    )
      .addText((text) =>
        text
          .setPlaceholder("10")
          .setValue(String(this.plugin.settings.maxReadFileSizeMb ?? 10))
          .onChange(async (value) => {
            const n = Number(value);
            if (Number.isFinite(n) && n > 0) {
              this.plugin.settings.maxReadFileSizeMb = n;
              await this.plugin.saveSettings();
            }
          })
      );

    // ── Security section ──────────────────────────────────────────
    // Single h3 with four sibling rows: two pattern-list toggles
    // (paths + commands), interactive CLI protection, and the
    // untrusted-content tagging panel. Pattern lists collapse by
    // default via native <details> so the page stays scannable; only
    // the at-a-glance toggles + one-liners are visible until the
    // user expands. This is the positioning-differentiator surface,
    // so legibility matters more than completeness-on-first-load.
    // Protected Mode — promoted to a section heading with master toggle.
    // Sub-items (Auto-deny + the two pattern lists) live inside a
    // container that gets dimmed when the master is OFF — user can
    // still see what's there but can't interact. Re-renders on master
    // toggle so the conditional Auto-deny row appears / disappears.
    const protectedModeOn = this.plugin.settings.protectedMode !== false;
    this._renderSectionHeading(containerEl, {
      title: "Protected Mode",
      tooltip:
        "Master switch for the protected-pattern feature.\n\n" +
        "ON (default): patterns below are enforced. The Auto-deny " +
        "sub-toggle picks the response — approve/deny modal (default) " +
        "or outright refusal with no modal.\n\n" +
        "OFF: patterns below are NOT enforced. Matches are treated " +
        "like any other op and follow your permission mode (Prompt / " +
        "Safe / YOLO) entirely. In YOLO this means protected patterns " +
        "become no-ops — real YOLO, by your explicit choice.",
      toggleKey: "protectedMode",
      onToggle: () => {
        this.plugin._resetActiveSessions();
        // Re-render so Auto-deny appears/disappears and sub-items
        // acquire/lose the dimmed state.
        this.display();
      },
    });

    // Everything inside this wrapper gets dimmed when Protected Mode is
    // OFF — the sub-items are still visible (so the user remembers what
    // they've configured) but can't be interacted with while the master
    // is down.
    const protectedContainer = containerEl.createEl("div", {
      cls: "gryphon-protected-children" +
        (protectedModeOn ? "" : " gryphon-section-disabled"),
    });

    // Auto-deny — tightly coupled to the master, so it sits directly
    // under it. Only rendered when Protected Mode is ON; when OFF, the
    // modal-vs-refuse distinction is moot (nothing triggers either way).
    if (protectedModeOn) {
      const autoDenySection = protectedContainer.createEl("div", {
        cls: "gryphon-protected-section gryphon-protected-subsection",
      });
      this._renderSecurityHeaderRow(autoDenySection, {
        title: "Auto-deny",
        shortDesc: "Refuse protected operations outright without showing a modal.",
        tooltipDetail:
          "ON: protected matches are refused immediately with a " +
          "prescriptive reason (open Settings → uncheck the matching " +
          "pattern → ask again). No approve/deny modal appears. " +
          "Useful for batch work where you'd rather edit Settings " +
          "once than dismiss repeated modals. " +
          "OFF (default): protected matches open the approve/deny " +
          "modal so you can decide case-by-case.",
        toggleKey: "autoDenyProtected",
        onToggle: () => this.plugin._resetActiveSessions(),
      });
    }

    this._renderProtectedChecklist(protectedContainer, {
      title: "Protect file paths",
      shortDesc: "Paths that always prompt before a write or edit — Gryphon's own settings plus any content you choose to protect.",
      manualAnchor: "Gryphon/MANUAL#Permission modes",
      defaults: DEFAULT_PROTECTED_PATHS,
      enabledKey: "protectedPathsEnabled",
      tooltipDetail:
        "Off = no path-based approval modal at any mode; Claude Code's " +
        "active permission mode is the only gate. Your per-pattern " +
        "selections are preserved while disabled, so re-enabling " +
        "restores exactly the prior configuration.",
      disabledKey: "protectedPathsDisabled",
      customKey: "protectedPathsCustom",
      addPlaceholder: "Journal/ or Archive/ or thesis.md",
      customHint:
        "Add your own folders or files here to protect irreplaceable content — " +
        "journals, archives, thesis drafts, anything you don't want overwritten " +
        "without a prompt. Trailing slash = whole folder; no slash = exact file.",
      customEmptyText:
        "Nothing added yet. Writes here always prompt — even in Safe or YOLO " +
        "mode — so use this for content you can't afford to silently lose.",
      validateNew: null,  // no regex for paths
    });

    this._renderProtectedChecklist(protectedContainer, {
      title: "Protect commands",
      shortDesc: "Shell commands that always prompt before running — even in YOLO mode.",
      manualAnchor: "Gryphon/MANUAL#Permission modes",
      defaults: DEFAULT_PROTECTED_COMMANDS,
      enabledKey: "protectedCommandsEnabled",
      tooltipDetail:
        "Off = no command-based approval modal at any mode; Claude Code's " +
        "active permission mode is the only gate. Your per-pattern " +
        "selections are preserved while disabled, so re-enabling " +
        "restores exactly the prior configuration.",
      disabledKey: "protectedCommandsDisabled",
      customKey: "protectedCommandsCustom",
      addPlaceholder: "e.g. sudo, or \\bopen\\s+-a\\b",
      customHint:
        "Add your own regex patterns for commands you always want to be " +
        "prompted on. Case-insensitive. JavaScript regex syntax.",
      validateNew: (val) => {
        try { new RegExp(val, "i"); return null; }
        catch (e) { return `Invalid pattern: ${e.message}`; }
      },
    });

    // Untrusted-content tagging — header row without a toggle (the
    // feature is always on when the plugin dir is writable), followed
    // by the status + action toolbar.
    if (this.plugin.provenanceStore) {
      const count = this.plugin.provenanceStore.size();
      const provSection = containerEl.createEl("div", { cls: "gryphon-protected-section" });
      this._renderSecurityHeaderRow(provSection, {
        title: "Untrusted-content tagging",
        shortDesc: `${count} file${count === 1 ? "" : "s"} currently tagged as originating from external sources.`,
        tooltipDetail:
          "When Claude reads a tagged file, Gryphon appends a notice " +
          "asking Claude to treat the content as data rather than " +
          "instructions. Tags persist across plugin reloads and are " +
          "applied automatically when a file is written during a " +
          "web-fetch session.",
        manualAnchor: "Gryphon/MANUAL",
      });

      // Action row: three buttons inline so they read as a toolbar,
      // not three separate settings with titles.
      const actions = provSection.createEl("div", { cls: "gryphon-provenance-actions" });
      const viewBtn = actions.createEl("button", { text: "View tagged files" });
      viewBtn.addEventListener("click", () => {
        this.plugin._openProvenanceListModal();
      });
      const cleanBtn = actions.createEl("button", { text: "Clean stale" });
      setTooltip(
        cleanBtn,
        "Remove tags for files that no longer exist on disk. Safe to run anytime.",
        { placement: "bottom" },
      );
      cleanBtn.addEventListener("click", async () => {
        const vaultRoot = this.plugin._vaultRoot();
        if (!vaultRoot) {
          new Notice("Vault root unavailable.");
          return;
        }
        try {
          const { removed } = this.plugin.provenanceStore.lint(vaultRoot);
          new Notice(
            removed.length === 0
              ? "No stale tags found."
              : `Removed ${removed.length} stale tag${removed.length === 1 ? "" : "s"}.`
          );
          this.display();
        } catch (e) {
          new Notice(`Lint failed: ${(e && e.message) || e}`);
        }
      });
      const clearBtn = actions.createEl("button", {
        text: "Clear all",
        cls: "mod-warning",
      });
      setTooltip(
        clearBtn,
        "Remove every tag. Files themselves are not touched, but Claude no longer gets a data-not-instructions notice when re-reading them.",
        { placement: "bottom" },
      );
      clearBtn.addEventListener("click", () => {
        this.plugin._confirmClearProvenance();
      });
    }

    // Diagnostics section. Opt-in (default off). Produces
    // console-side output useful for bug reports; never logs
    // message content, API keys, or vault paths beyond what's
    // already in the spawned argv.
    this._renderSectionHeading(containerEl, {
      title: "Diagnostics",
      tooltip:
        "Opt-in debug logging for troubleshooting and bug reports. " +
        "All output lands in Obsidian's Developer Tools console " +
        "(Cmd+Option+I on macOS, Ctrl+Shift+I on Linux / Windows) " +
        "— nothing is written to a file or sent off-device.",
    });
    this._descToTooltip(
      new Setting(containerEl).setName("CLI debug logging"),
      "When on, each CLI subprocess spawn logs its full argument " +
      "vector, hook-settings JSON contents, and (on spawn failure) " +
      "a structured diagnostic context to the console. Useful for " +
      "reporting \"(No response)\" cases or spawn errors. Off by default.",
    )
      .addToggle((toggle) =>
        toggle.setValue(!!this.plugin.settings.devCliDebug).onChange(async (value) => {
          this.plugin.settings.devCliDebug = !!value;
          await this.plugin.saveSettings();
        })
      );

    // Version footer. Two numbers can disagree here:
    //   - Obsidian's `this.manifest.version` is cached at app startup.
    //     Disable/enable does NOT refresh it — it updates only on full
    //     app restart. This is what the Community Plugins list shows.
    //   - The on-disk `manifest.json` is what a fresh build just wrote.
    //     Disable/enable DOES re-require main.js, so whichever plugin
    //     code is actually running is the one that reads the on-disk
    //     manifest here.
    // We display the on-disk version as authoritative, and if it
    // differs from Obsidian's cached label, tell the user so the lag
    // in the Community Plugins list is explained, not mysterious.
    const cachedVersion = (this.plugin.manifest && this.plugin.manifest.version) || "(unknown)";
    const versionEl = containerEl.createEl("div", {
      cls: "gryphon-settings-version",
      text: `Gryphon ${cachedVersion} (running)`,
    });
    this._readOnDiskVersion().then((disk) => {
      if (!disk) return;
      if (disk === cachedVersion) {
        versionEl.setText(`Gryphon ${disk} (running)`);
      } else {
        versionEl.setText(
          `Gryphon ${disk} (running). Obsidian's Community Plugins list still shows ${cachedVersion} — restart Obsidian to refresh that label.`,
        );
      }
    }).catch(() => {
      // Read failed — keep the cached value as-is so settings still
      // renders correctly.
    });
  }

  /**
   * Read the live manifest.json off disk via the vault adapter. Returns
   * the version string, or null if the read/parse fails.
   */
  async _readOnDiskVersion() {
    try {
      const id = this.plugin.manifest && this.plugin.manifest.id;
      const configDir = this.app.vault.configDir;  // usually ".obsidian"
      if (!id || !configDir) return null;
      const rel = `${configDir}/plugins/${id}/manifest.json`;
      const raw = await this.app.vault.adapter.read(rel);
      const parsed = JSON.parse(raw);
      return (parsed && typeof parsed.version === "string") ? parsed.version : null;
    } catch {
      return null;
    }
  }

  /**
   * Render a toggleable checklist for a protected-pattern category.
   * Defaults get checkboxes (enabled = not in the disabled set). User
   * additions appear below with a remove button. An input + Add button
   * at the bottom extends the custom list.
   *
   * The whole section re-renders on every mutation so indices stay
   * consistent — simpler than surgical DOM updates for a short list.
   */
  _renderProtectedChecklist(containerEl, opts) {
    const {
      title, shortDesc, defaults, disabledKey, customKey,
      addPlaceholder, validateNew,
      customHint = null,
      customEmptyText = "No custom entries. Add one below.",
      enabledKey, manualAnchor, tooltipDetail,
    } = opts;
    const section = containerEl.createEl("div", { cls: "gryphon-protected-section" });

    // Header row first (title + info icon + toggle on one line).
    // Late-bound applyEnabledVisual because listEl is created below
    // but the toggle's change handler needs to reach it.
    let applyEnabledVisual;
    this._renderSecurityHeaderRow(section, {
      title, shortDesc, tooltipDetail, manualAnchor,
      toggleKey: enabledKey,
      onToggle: (value) => { if (applyEnabledVisual) applyEnabledVisual(value); },
    });

    const listEl = section.createEl("div", { cls: "gryphon-protected-list" });
    applyEnabledVisual = (on) => {
      listEl.style.opacity = on ? "" : "0.45";
      listEl.style.pointerEvents = on ? "" : "none";
    };
    if (enabledKey) {
      applyEnabledVisual(this.plugin.settings[enabledKey] !== false);
    }

    const rerender = () => {
      listEl.empty();
      const settings = this.plugin.settings;
      if (!Array.isArray(settings[disabledKey])) settings[disabledKey] = [];
      if (!Array.isArray(settings[customKey])) settings[customKey] = [];
      const disabledSet = new Set(settings[disabledKey]);

      // Filter defaults by current OS — a Windows user doesn't need
      // `rm -rf` / `sudo` / `| bash` clutter in their checklist, and
      // likewise a macOS user doesn't want to scroll past every
      // `Remove-Item` / `del /s` / `reg add` / Windows-registry
      // pattern. Entries carry an optional `platforms` array
      // (`["posix"]`, `["windows"]`, both, or absent for
      // "applies everywhere"); we render only those that apply to
      // the host. This is UI-only — the classifier still evaluates
      // the full list at runtime so WSL / remote-SSH / cross-platform
      // command shapes are still caught.
      const platformKey = process.platform === "win32" ? "windows" : "posix";
      const visibleDefaults = defaults.filter((e) => {
        if (typeof e === "string") return true;
        if (!Array.isArray(e.platforms)) return true;
        return e.platforms.includes(platformKey);
      });

      // Defaults group — collapsible via native <details>. Default
      // closed so first-load view shows only the rule-count summary;
      // users who want to tune individual rules expand on demand.
      // Each default is either a plain string (legacy) or a
      // `{ pattern, userRisk, explanation, category, platforms }`
      // object (v0.5.0+). The tooltip starts from `userRisk`
      // (plain-language description written for non-developers) and
      // appends a settings-context line telling the user what
      // checking / unchecking this row actually does — because the
      // description alone doesn't answer "what happens if I flip
      // this switch."
      const activeCount = visibleDefaults.reduce((n, e) => {
        const p = typeof e === "string" ? e : e.pattern;
        return n + (disabledSet.has(p) ? 0 : 1);
      }, 0);
      const defaultsDetails = listEl.createEl("details", { cls: "gryphon-protected-details" });
      defaultsDetails.createEl("summary", {
        text: `Built-in rules — ${activeCount} of ${visibleDefaults.length} active`,
        cls: "gryphon-protected-summary",
      });
      for (const entry of visibleDefaults) {
        const pattern = typeof entry === "string" ? entry : entry.pattern;
        const description = typeof entry === "string"
          ? ""
          : (entry.userRisk || entry.explanation || "");
        const tooltip = description
          ? `${description}\n\n` +
            `Checked: Gryphon asks you before Claude does anything ` +
            `matching this — even in auto-approve modes. Unchecked: ` +
            `no warning, no prompt; Claude can proceed silently if ` +
            `your permission mode allows it.`
          : "";
        const row = defaultsDetails.createEl("label", { cls: "gryphon-protected-row" });
        // Use Obsidian's native tooltip for consistency with the
        // rest of the settings tab — right-placed, dark background.
        if (tooltip) setTooltip(row, tooltip, { placement: "bottom" });
        const cb = row.createEl("input", { type: "checkbox" });
        cb.checked = !disabledSet.has(pattern);
        cb.addEventListener("change", async () => {
          if (cb.checked) {
            settings[disabledKey] = settings[disabledKey].filter((p) => p !== pattern);
          } else if (!settings[disabledKey].includes(pattern)) {
            settings[disabledKey] = [...settings[disabledKey], pattern];
          }
          await this.plugin.saveSettings();
          // Re-render so the summary count updates to match. Minor
          // DOM churn; acceptable because toggling default rules is
          // a rare, deliberate action.
          rerender();
        });
        row.createEl("code", { text: pattern });
      }

      // Custom group — also collapsible so the settings page stays
      // compact even when users have added many entries. Stays
      // default-open when ANY custom exists (that's a clear "I care
      // about this" signal); closed when empty (just the Add input
      // matters).
      const customsOpen = settings[customKey].length > 0;
      const customsDetails = listEl.createEl("details", { cls: "gryphon-protected-details" });
      if (customsOpen) customsDetails.open = true;
      customsDetails.createEl("summary", {
        text: `Your rules — ${settings[customKey].length}`,
        cls: "gryphon-protected-summary",
      });
      if (customHint) {
        customsDetails.createEl("p", {
          cls: "gryphon-protected-custom-hint",
          text: customHint,
        });
      }
      if (settings[customKey].length === 0) {
        customsDetails.createEl("p", {
          cls: "gryphon-protected-empty",
          text: customEmptyText,
        });
      } else {
        for (let i = 0; i < settings[customKey].length; i++) {
          const pattern = settings[customKey][i];
          const row = customsDetails.createEl("div", { cls: "gryphon-protected-row gryphon-protected-row-custom" });
          row.createEl("code", { text: pattern });
          const removeBtn = row.createEl("button", { text: "×", cls: "gryphon-protected-remove", attr: { title: "Remove" } });
          removeBtn.addEventListener("click", async () => {
            settings[customKey] = settings[customKey].filter((_, idx) => idx !== i);
            await this.plugin.saveSettings();
            rerender();
          });
        }
      }

      // Add-new row (inside customsDetails so all custom-related UI
      // shares one collapsible region).
      const addRow = customsDetails.createEl("div", { cls: "gryphon-protected-add" });
      const input = addRow.createEl("input", {
        type: "text",
        cls: "gryphon-protected-add-input",
        attr: { placeholder: addPlaceholder },
      });
      const addBtn = addRow.createEl("button", { text: "Add", cls: "gryphon-protected-add-btn" });
      const errEl = addRow.createEl("span", { cls: "gryphon-protected-add-error" });

      const submit = async () => {
        const val = input.value.trim();
        errEl.setText("");
        if (!val) return;
        if (validateNew) {
          const err = validateNew(val);
          if (err) { errEl.setText(err); return; }
        }
        // Dedupe against defaults and existing customs
        if (defaults.includes(val) || settings[customKey].includes(val)) {
          errEl.setText("Already in the list.");
          return;
        }
        settings[customKey] = [...settings[customKey], val];
        await this.plugin.saveSettings();
        input.value = "";
        rerender();
      };
      addBtn.addEventListener("click", submit);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); submit(); }
      });
    };

    rerender();
  }

  /**
   * Render a section heading (h3) with an optional info icon and
   * optional master toggle on the header itself.
   *
   * Same affordance used throughout the settings tab for consistency —
   * hover the icon to see the section's description without eating a
   * paragraph of vertical space. When `toggleKey` is supplied the
   * heading also carries a right-aligned toggle, making it a true
   * master switch for the section's sub-items.
   *
   * @param {HTMLElement} parentEl
   * @param {object} opts
   *   title       — h3 label text
   *   tooltip     — optional description; when set, adds info icon
   *   toggleKey   — optional settings key; when set, renders a master
   *                 toggle on the header whose value is this.plugin.settings[toggleKey]
   *                 (default true — `!== false` semantic)
   *   onToggle    — optional callback invoked with (newValue) after the
   *                 setting is saved; typically used to re-render
   */
  _renderSectionHeading(parentEl, opts) {
    const { title, tooltip, toggleKey, onToggle } = opts;

    // When no toggle is needed, render a simple h3 with optional info
    // icon — unchanged from v0.9.x. Keeps the lightweight layout for
    // Provider / Defaults / Diagnostics section headers.
    if (!toggleKey) {
      const wrap = parentEl.createEl("div", { cls: "gryphon-section-heading" });
      wrap.createEl("h3", { text: title });
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

    // When the heading carries a master toggle, render as an Obsidian
    // Setting row so the toggle lands in `.setting-item-control` — the
    // same horizontal position every sub-toggle uses below. Without
    // this, a custom-positioned toggle ends up ~20px off from the
    // sub-toggles and the misalignment is immediately visible.
    //
    // Styling is promoted via `.gryphon-section-heading-row` so the
    // name reads like an h3 (larger, bold) and the row gets the
    // bottom border that h3 headers have.
    const setting = new Setting(parentEl).setName(title);
    setting.settingEl.classList.add(
      "gryphon-section-heading",
      "gryphon-section-heading-row",
    );
    if (tooltip) this._descToTooltip(setting, tooltip);
    else setting.setDesc("");
    setting.addToggle((toggle) => {
      const current = this.plugin.settings[toggleKey] !== false;
      toggle.setValue(current).onChange(async (value) => {
        this.plugin.settings[toggleKey] = !!value;
        await this.plugin.saveSettings();
        if (onToggle) onToggle(!!value);
      });
    });
    return setting;
  }

  /**
   * Collapse a Setting row's description into Obsidian's native
   * tooltip, attached to an `(i)` info icon appended to the row's
   * name span. Matches the Security section rows so the info-icon
   * affordance is consistent everywhere in the settings tab: any
   * row with an explanation shows the icon, any row without one
   * doesn't.
   *
   * Tooltip placement is "bottom" so the popup drops below the
   * triggering element. Obsidian's tooltip implementation clamps
   * to the viewport and auto-flips to "top" when the row sits near
   * the bottom of the visible settings area — prevents clipping at
   * either edge without us doing manual geometry.
   */
  _descToTooltip(setting, tooltipText) {
    if (!setting || !tooltipText) return setting;
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
   * One-line header row for the Security section. Uses Obsidian's
   * native `Setting` so the toggle's right-edge alignment matches
   * every other Setting in the tab (Provider, API keys, etc.) —
   * the previous custom flex div sat inside its own padding context
   * and pushed the toggle further right than siblings, which looked
   * like misalignment.
   *
   * Info icon lives inside `setting.nameEl`; tooltip attached to it.
   * Hover-only — no click-through to MANUAL.md, since that leaves
   * the settings tab with no obvious back affordance.
   *
   * @param {HTMLElement} parentEl
   * @param {object} opts
   *   title         — string, the row label
   *   shortDesc     — string, short one-liner; combined into tooltip
   *   tooltipDetail — string, longer explanation; combined into tooltip
   *   toggleKey     — string|undefined, settings key to bind toggle
   *   onToggle      — fn(bool), called after the toggle persists
   */
  _renderSecurityHeaderRow(parentEl, opts) {
    const { title, shortDesc, tooltipDetail, toggleKey, onToggle } = opts;
    const setting = new Setting(parentEl).setName(title);
    setting.setDesc("");  // no visible description; tooltip carries it

    const tooltipText = [shortDesc, tooltipDetail].filter(Boolean).join("\n\n");
    if (tooltipText) {
      const info = setting.nameEl.createEl("span", {
        cls: "gryphon-info-icon gryphon-info-icon-inline",
        attr: { tabindex: "0" },
      });
      info.createEl("span", { text: "i", cls: "gryphon-info-icon-glyph" });
      setTooltip(info, tooltipText, { placement: "bottom" });
    }

    if (toggleKey) {
      setting.addToggle((toggle) => {
        const current = this.plugin.settings[toggleKey] !== false;
        toggle.setValue(current).onChange(async (value) => {
          this.plugin.settings[toggleKey] = !!value;
          await this.plugin.saveSettings();
          if (onToggle) onToggle(!!value);
        });
      });
    }
    return setting;
  }
}

// Plugins that embed Gryphon's chat view via composition should declare
// their ID here so Gryphon can stand aside when they're loaded (avoids
// duplicate view-type registration + conflicting ribbon icons). Host
// plugins are expected to register themselves in this list via a PR to
// the Gryphon repo, or equivalently, to invoke Obsidian's disablePlugin
// on "gryphon" themselves during their own onload.
const GRYPHON_HOST_PLUGIN_IDS = [];

class GryphonPlugin extends Plugin {
  async onload() {
    // Mutual exclusivity: if any plugin that embeds Gryphon is loaded,
    // defer to it to avoid duplicate view/ribbon registration.
    for (const hostId of GRYPHON_HOST_PLUGIN_IDS) {
      if (this.app.plugins.enabledPlugins.has(hostId)) {
        new Notice(
          `The "${hostId}" plugin embeds Gryphon — disable it to run ` +
          `Gryphon standalone.`,
          10000
        );
        return;
      }
    }

    await this.loadSettings();

    // v0.6.0: bring up the IPC server that local-CLI hooks talk back
    // to. Started unconditionally (cheap, no external exposure — Unix
    // socket with 0600 perms). The CLI provider only wires CC to this
    // socket when Protected Mode is on AND Auto-deny is off; flipping
    // either off reverts runtime behavior to the deny-list fallback
    // (or to no enforcement) without touching this server.
    // Provenance store for untrusted-origin file tags (v0.6.0 Stage 6).
    // Safe when absolutePluginDir() is null — we skip provenance in
    // that case and the plugin still functions with framing-by-tool
    // but without persistent tags. Session flags live on the plugin
    // instance (cleared on unload), keyed by CC session_id.
    const pluginDir = this.absolutePluginDir();
    this.provenanceStore = pluginDir ? new ProvenanceStore(pluginDir) : null;
    this._sessionFlags = new Map();  // session_id → { untrustedContentActive: bool }

    // ONE sweeper, called once per plugin load. Cleans up every
    // temp/state file Gryphon can leave behind across crashes and
    // reloads. Pid-liveness protects concurrent Obsidian windows
    // from having their in-flight files touched.
    try {
      const s = sweepGryphonOrphans({
        pluginDir,
        truncateTraceLog: !!(this.settings && this.settings.devCliDebug),
      });
      if (s.totalRemoved > 0) {
        console.log(
          `[gryphon] orphan sweep: removed ${s.totalRemoved} file(s) ` +
          `(hook-settings:${s.hookSettings.removed.length}, ` +
          `sockets:${s.sockets.removed.length}, ` +
          `provenance-tmp:${s.provenanceTmp.removed.length}, ` +
          `chat-history-tmp:${s.chatHistoryTmp.removed.length})`
        );
      }
    } catch (e) {
      console.warn("[gryphon] orphan sweep failed:", e && e.message);
    }

    this.ipcServer = new PermissionIPCServer();
    this._registerIpcHandlers(this.ipcServer);
    // Cache the bound socket path so ensureIpcListening can re-bind
    // to the SAME path on recovery. If we rebind to a new path, any
    // already-spawned CC child process still points its
    // GRYPHON_PERMISSION_SOCKET env var at the old path — its hooks
    // connect to a dead endpoint and silently fail (CC treats exit≠0
    // as "allow"). Multi-view / openInMainTab users hit this.
    this._ipcSocketPath = defaultSocketPath();
    try {
      await this.ipcServer.create(this._ipcSocketPath);
    } catch (e) {
      console.warn("[gryphon] IPC server failed to start:", e && e.message);
      this.ipcServer = null;
      // Also surface via Notice — onload failures previously only hit
      // console.warn, so users had zero signal until their first CLI
      // send (which could be hours/days later).
      try {
        const { Notice } = require("obsidian");
        new Notice(
          `Gryphon: IPC server failed to start (${(e && e.message) || e}). ` +
          `Claude Code mode will run with basic pattern enforcement only (no Unicode ` +
          `normalization). Reload Obsidian (Cmd/Ctrl+P → "Reload app without ` +
          `saving") to retry.`,
          15000,
        );
      } catch (_) { /* obsidian unavailable in tests */ }
    }

    this.skillRegistry = new SkillRegistry(this.app);
    // Init asynchronously — folder seeding + scan. The view consults the
    // registry lazily (on every autocomplete update), so if init finishes
    // after the view mounts, skills appear on the next keystroke.
    this.skillRegistry.init().catch((e) =>
      console.warn("[gryphon] SkillRegistry init failed:", e)
    );

    this.registerView(
      VIEW_TYPE,
      (leaf) =>
        new GryphonChatView(leaf, this, {
          viewType: VIEW_TYPE,
          displayText: "Gryphon",
          icon: "shield-check",
        })
    );

    this.addRibbonIcon("shield-check", "Open Gryphon", () => this.activateView());

    this.addCommand({
      id: "open-gryphon",
      name: "Open Gryphon chat",
      callback: () => this.activateView(),
    });

    // Uses `callback` (not `editorCallback`) so the command is
    // available from any context — including Reading mode which has no
    // editor. Internally cascades: active editor selection → window
    // DOM selection → cached selection from the chat view's
    // selectionchange listener. Assign a hotkey in Settings → Hotkeys
    // for one-key quoting without a command palette round-trip.
    this.addCommand({
      id: "quote-highlight-into-gryphon",
      name: "Quote highlighted text into Gryphon chat",
      callback: async () => {
        const picked = this._pickSelectionForInjection();
        if (!picked) {
          new Notice("Gryphon: no text selected");
          return;
        }
        await this.activateView();
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
        const gryphonView = leaves[0] && leaves[0].view;
        if (gryphonView && typeof gryphonView.insertSelectionIntoInput === "function") {
          gryphonView.insertSelectionIntoInput(picked.text, picked.file);
        } else {
          new Notice("Gryphon: chat view not available");
        }
      },
    });

    this.addSettingTab(new GryphonSettingTab(this.app, this));
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      const newLeaf = this.settings.openInMainTab
        ? workspace.getLeaf("tab")
        : workspace.getRightLeaf(false);
      if (newLeaf) {
        await newLeaf.setViewState({ type: VIEW_TYPE, active: true });
        leaf = newLeaf;
      }
    }
    if (leaf) {
      workspace.revealLeaf(leaf);
      requestAnimationFrame(() => {
        if (leaf.view.inputEl) leaf.view.inputEl.focus();
      });
    }
  }

  /**
   * Cascade through three sources to find a selection to inject, matching
   * the chat view's internal cascade. Exposed here so the Obsidian command
   * can find a selection even when the chat view isn't open yet (cached
   * selection on the view isn't available until the view is instantiated).
   */
  _pickSelectionForInjection() {
    // 1. Chat view's cached selection (includes Reading mode captures)
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    const viewCache = leaves[0] && leaves[0].view && leaves[0].view._cachedSelection;
    if (viewCache && viewCache.text) {
      return { text: viewCache.text, file: viewCache.file };
    }
    // 2. Active editor selection (Source / Live Preview)
    const { MarkdownView } = require("obsidian");
    const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (mdView && mdView.editor) {
      const sel = mdView.editor.getSelection();
      if (sel) return { text: sel, file: mdView.file || null };
    }
    // 3. Current window DOM selection (Reading mode at call time)
    const winSel = document.getSelection();
    if (winSel && !winSel.isCollapsed) {
      const text = winSel.toString();
      if (text) return { text, file: this.app.workspace.getActiveFile() };
    }
    return null;
  }

  /**
   * Apply settings changes to open chat views: abort any in-flight
   * provider session (so the new model/effort/permission/key takes effect
   * on the NEXT message rather than mid-stream), and refresh the welcome
   * panel (so it disappears once the user configures a provider in
   * settings, no plugin reload required).
   */
  _resetActiveSessions() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const view = leaf.view;
      if (!view) continue;
      if (view.claudeProcess && view.claudeProcess.isAlive && view.claudeProcess.isAlive()) {
        view.claudeProcess.abort();
        view.claudeProcess = null;
        if (typeof view.addSystemMessage === "function") {
          view.addSystemMessage("Setting updated — takes effect on next message");
        }
      }
      if (typeof view.refreshWelcomePanel === "function") {
        view.refreshWelcomePanel();
      }
    }
  }

  /**
   * Surface a canonical refusal reason in every open chat view,
   * independent of what the model later relays. This runs alongside
   * the model's normal response path — the model still sees the
   * refusal in the tool result and writes its own commentary — but
   * guarantees the user sees our exact prescriptive text regardless
   * of model variance.
   *
   * Called from:
   *   - _handleClassifyRequest (Claude Code mode, hook-based protected deny)
   *   - permission-gate.js::checkPermission (Anthropic API mode, protected deny
   *     either via modal or auto-deny)
   *
   * No-op when no chat view is open (e.g., test harness, headless).
   * chat-view.addRefusalMessage dedupes same-text within 3s so
   * duplicate calls from adjacent code paths don't render twice.
   */
  _emitRefusalToChatViews(reason) {
    if (!reason || typeof reason !== "string") return;
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const view = leaf.view;
      if (view && typeof view.addRefusalMessage === "function") {
        try { view.addRefusalMessage(reason); }
        catch (e) { console.warn("[gryphon] addRefusalMessage failed:", e.message); }
      }
    }
  }

  async onunload() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view.claudeProcess) leaf.view.claudeProcess.abort();
    }
    if (this.skillRegistry) this.skillRegistry.unload();
    // Close IPC server last so any in-flight hook request from a CC
    // process we just aborted gets a clean connection drop rather than
    // a stranded half-response.
    if (this.ipcServer) {
      try { await this.ipcServer.close(); } catch (_) { /* best-effort */ }
      this.ipcServer = null;
    }
  }

  /**
   * Absolute filesystem path to this plugin's directory (where
   * main.js + manifest.json + hooks/ live). Used by the CLI provider
   * when building the hook settings file for the local CLI. Returns
   * null when the vault adapter doesn't expose a basePath (e.g. some
   * non-file-backed test environments).
   */
  absolutePluginDir() {
    const base = this.app && this.app.vault && this.app.vault.adapter && this.app.vault.adapter.basePath;
    const id = this.manifest && this.manifest.id;
    const configDir = this.app && this.app.vault && this.app.vault.configDir;
    if (!base || !id || !configDir) return null;
    return path.join(base, configDir, "plugins", id);
  }

  /**
   * Register IPC request handlers the local-CLI hook scripts call.
   * Kept on the plugin instance so handlers close over plugin state
   * (vault root, settings, modal lifecycle) without passing them
   * through the socket on every request.
   *
   * Fail-closed for `classify`: any thrown error inside classification
   * or the modal flow is converted to a deny with a visible reason,
   * per design invariant #3.
   */
  _registerIpcHandlers(server) {
    server.on("classify", async (req) => this._handleClassifyRequest(req));
    server.on("event", async (req) => this._handleEventRequest(req));
    server.on("provenance_check", async (req) => this._handleProvenanceCheck(req));
    server.on("provenance_add", async (req) => this._handleProvenanceAdd(req));
    server.on("provenance_mark", async (req) => this._handleProvenanceMark(req));
    server.on("session_end", async (req) => this._handleSessionEnd(req));
    server.on("ping", async (req) => this._handlePing(req));
    server.on("notice", async (req) => this._handleNotice(req));
  }

  /**
   * Ensure the IPC server is currently listening before a CLI provider
   * spawns. Auto-recovers from the transient !isListening state that
   * can occur during plugin disable/enable cycles (seen in Windows
   * testing: one spawn landed in the window between ipcServer.close()
   * and a new ipcServer.create() completing, causing the CLI deny-glob
   * fallback to kick in and silently lose NFKC normalization).
   *
   * Contract:
   *   - If already listening → resolves true immediately (no-op hot path)
   *   - If not listening and server object exists → attempts re-create
   *     with a timeout
   *   - If server object is null entirely → returns false (plugin load
   *     failed upstream; not recoverable from here)
   *
   * The in-flight guard (`_creatingPromise` on PermissionIPCServer)
   * handles the case where another create is already running — the
   * second call just awaits the first.
   */
  async ensureIpcListening(timeoutMs = 2000) {
    if (this.ipcServer && this.ipcServer.isListening()) return true;
    if (!this.ipcServer) return false;

    // Reuse the originally-bound path, not a fresh one. Already-
    // spawned CC children hold GRYPHON_PERMISSION_SOCKET pointing at
    // the first path — rebinding elsewhere leaves them connecting
    // to a dead endpoint. Fallback to a fresh path only if we somehow
    // lost the cache (shouldn't happen, but defensive).
    const { defaultSocketPath } = require("./providers/shared/permission-ipc-server");
    const socketPath = this._ipcSocketPath || defaultSocketPath();
    try {
      await Promise.race([
        this.ipcServer.create(socketPath),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("ipc-recovery-timeout")), timeoutMs),
        ),
      ]);
      return !!(this.ipcServer && this.ipcServer.isListening());
    } catch (e) {
      // If the error is "already created" (a racing path beat us to
      // binding), the server is actually healthy — return the real
      // state rather than propagating a spurious failure.
      if (this.ipcServer && this.ipcServer.isListening()) return true;
      console.warn(
        "[gryphon] IPC recovery failed:",
        (e && e.message) || e,
        "— CLI spawn will proceed on fallback path",
      );
      return false;
    }
  }

  /**
   * Reachability check for the SessionStart hook. Returns `{ok: true}`
   * if the plugin is loaded, the IPC server is listening, and the
   * provenance store (if applicable) is healthy. Anything else returns
   * `{ok: false, reason}`. SessionStart fail-closes on non-ok.
   */
  async _handlePing(_req) {
    if (!this.ipcServer || !this.ipcServer.isListening()) {
      return { ok: false, reason: "ipc-server-not-listening" };
    }
    if (this.provenanceStore && this.provenanceStore.isLoadFailed()) {
      // Provenance is degraded but tagging-only-degraded — we still
      // want sessions to start; just flag the state in the response
      // so a future UI can surface it. Pass-back a notice rather than
      // failing the session.
      return { ok: true, provenanceLoadError: this.provenanceStore.loadErrorMessage() };
    }
    return { ok: true };
  }

  /**
   * Forward a local-CLI notification into Obsidian's Notice popup.
   * Throttled implicitly by the hook script's 1s timeout — a runaway
   * CLI pushing dozens of notices/sec would still flood Obsidian, but
   * per-notice cost is just a DOM toast.
   *
   * Truncates to 280 chars defensively (the hook also truncates).
   * Notice duration scales loosely with length — short messages get
   * the Obsidian default; longer ones stay around longer.
   */
  async _handleNotice(req) {
    const message = req && typeof req.message === "string" ? req.message : "";
    if (!message) return { ok: false, reason: "empty-message" };
    const display = message.length > 280 ? message.slice(0, 277) + "..." : message;
    const durationMs = display.length > 80 ? 8000 : 4000;
    try {
      new Notice(`CLI: ${display}`, durationMs);
    } catch (e) {
      return { ok: false, reason: (e && e.message) || String(e) };
    }
    return { ok: true };
  }

  /**
   * Resolve a path the hook handed us into the canonical vault-relative
   * key used by the provenance store. Returns null for paths that are
   * outside the vault (those aren't persistently tagged — the
   * vault-boundary framing rule in posttool.js already frames them).
   */
  _toVaultRelKey(p, cwd) {
    const vaultRoot = this._vaultRoot();
    if (!vaultRoot || typeof p !== "string" || !p) return null;
    const base = cwd && typeof cwd === "string" ? cwd : vaultRoot;
    // Round-12 F10 collapsed `..` via path.resolve. Round-14 Q1 extends
    // to symlinks: fs.realpathSync follows symlinks so an in-vault
    // symlink pointing outside gets classified correctly. Fall back to
    // path.resolve for paths that don't exist on disk (e.g. a Write to
    // a not-yet-created path).
    const lexical = path.isAbsolute(p) ? path.resolve(p) : path.resolve(base, p);
    const fs = require("fs");
    let resolved;
    try { resolved = fs.realpathSync(lexical); }
    catch (_) { resolved = lexical; }
    let normalizedRoot;
    try { normalizedRoot = fs.realpathSync(path.resolve(vaultRoot)); }
    catch (_) { normalizedRoot = path.resolve(vaultRoot); }
    if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + path.sep)) {
      return null;  // outside vault
    }
    return path.relative(normalizedRoot, resolved).replace(/\\/g, "/");
  }

  _vaultRoot() {
    return (this.app && this.app.vault && this.app.vault.adapter
      && this.app.vault.adapter.basePath) || null;
  }

  _sessionFlagsFor(sessionId) {
    if (typeof sessionId !== "string" || !sessionId) return null;
    if (!this._sessionFlags.has(sessionId)) {
      this._sessionFlags.set(sessionId, { untrustedContentActive: false });
    }
    return this._sessionFlags.get(sessionId);
  }

  /**
   * Mark a session flag (currently just `untrustedContentActive`),
   * and capture the origin of the mark on `lastUntrustedSource` so a
   * subsequent Write in the same session can propagate the origin
   * into its persistent provenance tag. Without this, a file tagged
   * "Write-after-WebFetch" has no record of WHICH URL the session
   * fetched — breaking audit traceability when a specific URL later
   * proves problematic.
   *
   * Last-write-wins for lastUntrustedSource: if the session fetches
   * URL A, then fetches URL B, then writes file X, X is attributed
   * to B. Matches user intuition (most recent fetch is the likely
   * provenance).
   */
  async _handleProvenanceMark(req) {
    const sid = req && req.sessionId;
    const flag = req && typeof req.flag === "string" ? req.flag : null;
    if (!sid || !flag) return { ok: false, error: "missing sessionId/flag" };
    const flags = this._sessionFlagsFor(sid);
    if (!flags) return { ok: false, error: "invalid sessionId" };
    flags[flag] = true;
    if (req.sourceTool) {
      flags.lastUntrustedSource = {
        tool: req.sourceTool,
        sourceUrl: req.sourceUrl || undefined,
        sourceQuery: req.sourceQuery || undefined,
        sourceCommand: req.sourceCommand || undefined,
        ts: Date.now(),
      };
    }
    return { ok: true };
  }

  /**
   * Check whether a path is tagged. Returns { tagged, metadata, sessionFlags }
   * so the hook can decide framing + source attribution in one round trip.
   */
  async _handleProvenanceCheck(req) {
    if (!this.provenanceStore) return { tagged: false };
    const key = this._toVaultRelKey(req && req.path, req && req.cwd);
    const sid = req && req.sessionId;
    const flags = sid ? this._sessionFlagsFor(sid) : null;
    if (!key) {
      // Outside vault (or empty path). Not persistently tagged, but
      // expose session flags so the caller can still attribute
      // untrustedContentActive context for out-of-vault reads.
      return { tagged: false, sessionFlags: flags || null };
    }
    const metadata = this.provenanceStore.get(key);
    return {
      tagged: !!metadata,
      metadata: metadata || null,
      sessionFlags: flags || null,
    };
  }

  /**
   * Add a tag. Caller supplies path + metadata; we normalise the path
   * and persist. Returns { tagged, key } so the hook knows whether the
   * add was stored (tagged=false means path was outside vault).
   */
  async _handleProvenanceAdd(req) {
    if (!this.provenanceStore) return { tagged: false, error: "store unavailable" };
    const key = this._toVaultRelKey(req && req.path, req && req.cwd);
    if (!key) return { tagged: false };
    const source = req && typeof req.source === "string" ? req.source : null;
    if (!source) return { tagged: false, error: "source required" };
    try {
      this.provenanceStore.add(key, {
        source,
        sourceUrl: req.sourceUrl,
        sourceCommand: req.sourceCommand,
        sessionId: req.sessionId,
      });
    } catch (e) {
      return { tagged: false, error: (e && e.message) || String(e) };
    }
    return { tagged: true, key };
  }

  /**
   * Session-end cleanup ping. Drop this session's in-memory flags.
   * (Stage 7 wires the session-end hook to send this.)
   */
  async _handleSessionEnd(req) {
    const sid = req && req.sessionId;
    if (sid) this._sessionFlags.delete(sid);
    return { ok: true };
  }

  /**
   * Open a read-only modal listing every tagged file with its source
   * metadata. Used by the settings tab. Plain DOM — no need for the
   * full SettingTab machinery for a one-shot listing.
   */
  _openProvenanceListModal() {
    if (!this.provenanceStore) return;
    const modal = new Modal(this.app);
    modal.titleEl.setText("Untrusted-content tags");
    const entries = this.provenanceStore.list().sort((a, b) =>
      a.path.localeCompare(b.path)
    );
    if (entries.length === 0) {
      modal.contentEl.createEl("p", { text: "No tagged files." });
    } else {
      const table = modal.contentEl.createEl("table", {
        cls: "gryphon-provenance-list",
      });
      table.style.width = "100%";
      table.style.fontSize = "12px";
      table.style.borderCollapse = "collapse";
      const head = table.createEl("tr");
      for (const h of ["Path", "Source", "Origin", "Tagged at"]) {
        const th = head.createEl("th", { text: h });
        th.style.textAlign = "left";
        th.style.padding = "4px 8px";
        th.style.borderBottom = "1px solid var(--background-modifier-border)";
      }
      for (const { path: p, metadata } of entries) {
        const tr = table.createEl("tr");
        const cells = [
          p,
          metadata.source || "?",
          metadata.sourceUrl || metadata.sourceCommand || "—",
          _formatTaggedAt(metadata.taggedAt),
        ];
        for (const text of cells) {
          const td = tr.createEl("td", { text: String(text) });
          td.style.padding = "4px 8px";
          td.style.verticalAlign = "top";
          td.style.wordBreak = "break-all";
        }
      }
    }
    modal.open();
  }

  /**
   * Confirm + clear all provenance tags. Confirmation is a separate
   * modal so the user can't fat-finger the button in the settings tab.
   */
  _confirmClearProvenance() {
    if (!this.provenanceStore) return;
    const modal = new Modal(this.app);
    modal.titleEl.setText("Clear all untrusted-content tags?");
    modal.contentEl.createEl("p", {
      text:
        "This removes every tag, but does NOT delete the files themselves. " +
        "Claude will no longer be warned about previously-tagged content " +
        "until those files are re-tagged.",
    });
    new Setting(modal.contentEl)
      .addButton((btn) =>
        btn.setButtonText("Cancel").onClick(() => modal.close())
      )
      .addButton((btn) =>
        btn.setButtonText("Clear all").setWarning().onClick(() => {
          try {
            this.provenanceStore.clear();
            new Notice("Cleared all tags.");
          } catch (e) {
            new Notice(`Clear failed: ${(e && e.message) || e}`);
          }
          modal.close();
          // Round-8 F7: refresh the settings tab via the stashed
          // reference (PluginSettingTab.display() is idempotent).
          // getActiveViewOfType doesn't work for settings tabs.
          if (this._activeSettingTab && typeof this._activeSettingTab.display === "function") {
            this._activeSettingTab.display();
          }
        })
      );
    modal.open();
  }

  /**
   * Record a telemetry event from a hook. Stage 5 just keeps a capped
   * in-memory ring buffer — Stage 7/8 will either forward to a JSONL
   * sink, surface in the settings UI, or both. Keeping the handler
   * shape stable now so hooks can start emitting events in the Stage 5
   * window without a downstream consumer yet.
   *
   * Ack-only response; hooks call `event` as fire-and-forget and do
   * not wait for the reply (ipc-client's emitEvent has a 5s timeout).
   */
  async _handleEventRequest(req) {
    if (!this._events) this._events = [];
    // Cap at 500 events to bound memory — events are transient; long-
    // running sessions that actually hit this cap likely have a
    // misbehaving scanner we'd want to know about anyway.
    if (this._events.length >= 500) this._events.shift();
    this._events.push({
      ts: Date.now(),
      type: (req && req.type) || "unknown",
      tool: (req && req.tool) || null,
      patternId: (req && req.patternId) || null,
      severity: (req && req.severity) || null,
      sessionId: (req && req.sessionId) || null,
    });
    return { ok: true };
  }

  async _handleClassifyRequest(req) {
    const tool = req && typeof req.tool === "string" ? req.tool : null;
    const input = req && req.input && typeof req.input === "object" ? req.input : null;
    if (!tool || !input) {
      return { decision: "deny", reason: "gryphon: classify request missing tool/input" };
    }
    const vaultRoot = this.app && this.app.vault && this.app.vault.adapter && this.app.vault.adapter.basePath;
    if (!vaultRoot) {
      return { decision: "deny", reason: "gryphon: vault root unavailable" };
    }
    const ctx = {
      vaultRoot,
      plugin: this,
      permissionMode: (req && req.permissionMode) || this.settings.permissionMode || "default",
    };

    let classification;
    try {
      classification = attackDetector.classify(tool, input, ctx);
    } catch (e) {
      return {
        decision: "deny",
        reason: `gryphon: classification failed: ${(e && e.message) || e}`,
      };
    }

    // Route decision by tool + match:
    //
    //   Read-only tools (Read, Glob, Grep, WebFetch, WebSearch, etc.):
    //     Always allow — they don't mutate state. Their outputs carry
    //     the threat (handled by PostToolUse framing), not their inputs.
    //
    //   Mutating tools (Bash, PowerShell, Write, Edit), no protected match:
    //     Route through gate() so the user's permission mode still
    //     applies. Prompt mode shows a modal on every call; Safe mode
    //     auto-accepts file edits but still prompts for shell; YOLO
    //     auto-accepts. Previous `if (!classification) return allow`
    //     short-circuit bypassed this entirely — meaning Claude Code mode
    //     silently auto-allowed every routine command even in Prompt
    //     mode. Anthropic API mode didn't have this bug because bash.js /
    //     edit.js / write.js each call gate() directly in-process.
    //
    //   Any tool with a protected-pattern match:
    //     gate() upgrades kind to protected-exec / protected and
    //     ignores the mode fast-paths — always modal, even in YOLO.
    const isMutating =
      tool === "Bash" || tool === "PowerShell" ||
      tool === "Write" || tool === "Edit";
    if (!classification && !isMutating) {
      return { decision: "allow" };
    }
    // Auto-deny + no classification → short-circuit to allow. Hooks
    // are enabled in auto-deny mode SO the Unicode-normalization path
    // in classify() fires on shapes the byte-exact deny-globs miss
    // (fullwidth `ｒｍ`, zero-width-joined `r​m`). But the auto-deny
    // UX contract is "no modal prompts for routine ops" — so when the
    // pattern check returns null, we must bypass gate() (which would
    // modal in default permission mode for mutating tools) and allow
    // the call. CC still enforces its own permission mode; we're the
    // guardrail for protected patterns only.
    if (!classification && this.settings.autoDenyProtected === true) {
      return { decision: "allow" };
    }

    const { action, target } = _deriveActionTarget(tool, input);
    const kind = (tool === "Bash" || tool === "PowerShell") ? "exec" : "fileEdit";
    let gateResult;
    try {
      gateResult = await attackDetector.gate(classification, {
        ctx, action, target, detail: null, kind, cacheable: false,
      });
    } catch (e) {
      return {
        decision: "deny",
        reason: `gryphon: permission modal failed: ${(e && e.message) || e}`,
      };
    }

    // Compose a user-facing deny reason so the model has something
    // concrete to relay verbatim rather than improvise from an
    // internal regex string. Two paths:
    //
    //  (a) Protected-pattern match (classification truthy): describe
    //      which protected-pattern category matched and point at the
    //      exact settings location to adjust.
    //  (b) User-denied-via-modal (classification null): acknowledge
    //      the decline without explaining the mechanism.
    //
    // Both phrasings avoid the vocabulary listed in GRYPHON_SYSTEM_PROMPT_HINT's
    // forbidden-words list (hook, PreToolUse, IPC, etc.) so the model
    // can quote them directly without needing to rewrite.
    let displayReason;
    if (gateResult && gateResult.allow) {
      displayReason = "";
    } else if (classification) {
      const categoryLabel = classification.category
        ? classification.category.replace(/-/g, " ")
        : "protected pattern";
      const settingsPath = tool === "Write" || tool === "Edit"
        ? "Protected file paths"
        : "Protected commands";
      // Pre-bulleted format so the model has no reason to re-structure
      // it. Earlier arrow-chain versions were frequently reformatted
      // into bullet lists by Claude even under strict "quote verbatim"
      // directives — giving the model a bulleted source removes the
      // incentive. Markdown `- ` renders as bullets in Obsidian's
      // message view; in plain-text fallbacks it reads as a dash list,
      // which is still clean.
      displayReason =
        `This operation matches one of your protected patterns in Gryphon ` +
        `(${categoryLabel}).\n\nTo allow it:\n` +
        `- Open Obsidian → Settings → Gryphon → ${settingsPath}\n` +
        `- Uncheck the matching pattern\n` +
        `- Ask me again`;
    } else {
      displayReason = `You declined ${action} on ${target}. Want me to try a different approach?`;
    }

    // v0.9.2: the earlier Option E path used to render the canonical
    // refusal reason directly in the chat view as a safety net
    // against model paraphrasing drift. With the per-turn reminder
    // injection (dd77fb0), observation showed the model reliably
    // echoes our canonical text verbatim — making the direct render
    // pure duplication. Kept the plumbing
    // (`_emitRefusalToChatViews` + `addRefusalMessage` + CSS) so
    // future regressions can re-enable it with a single call.
    //
    // If LLM variance starts leaking "hook" / workaround suggestions
    // again in practice, uncomment the emit here and in
    // permission-gate.js to restore the safety-net UX.

    return {
      decision: gateResult && gateResult.allow ? "allow" : "deny",
      reason: displayReason,
      matchedPattern: classification ? classification.matchedPattern : undefined,
      category: classification ? classification.category : undefined,
    };
  }

  async loadSettings() {
    // Keep the raw user-saved data before merging with defaults. Migration
    // needs it to distinguish "user explicitly set X" from "default filled
    // X in" — Object.assign collapses those two cases into the same value.
    const userData = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, userData);
    this._migrateSettings(userData);
  }

  /**
   * Migrate settings from older shapes so upgrades don't wipe state:
   *   v0.3.3: protectedPaths / protectedCommands were newline-separated
   *           strings in a single textarea. v0.4.2 splits into disabled +
   *           custom arrays. Move old non-default entries into custom.
   *
   * @param {object} userData — the raw user-saved data BEFORE defaults
   *                            were merged. Lets us detect whether the
   *                            user explicitly set a new key or inherited
   *                            the default.
   */
  _migrateSettings(userData = {}) {
    const migrateList = (oldKey, customKey, defaults) => {
      const old = this.settings[oldKey];
      if (typeof old !== "string") return;
      const lines = old.split(/\r?\n/).map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith("#"));
      const migrated = lines.filter((l) => !defaults.includes(l));
      if (migrated.length > 0) {
        const existing = Array.isArray(this.settings[customKey]) ? this.settings[customKey] : [];
        this.settings[customKey] = [...existing, ...migrated.filter((p) => !existing.includes(p))];
      }
      delete this.settings[oldKey];
    };
    migrateList("protectedPaths", "protectedPathsCustom", DEFAULT_PROTECTED_PATHS);
    migrateList("protectedCommands", "protectedCommandsCustom", DEFAULT_PROTECTED_COMMANDS);

    // v0.9.2: hookInstrumentation → protectedMode + autoDenyProtected.
    // Old semantics:
    //   hookInstrumentation=true  → modal via hooks
    //   hookInstrumentation=false → deny-only via --disallowedTools
    // New semantics:
    //   protectedMode=true  + autoDenyProtected=false → modal       (same as old ON)
    //   protectedMode=true  + autoDenyProtected=true  → deny-only   (same as old OFF)
    //   protectedMode=false                           → no enforcement (new)
    //
    // Carry the user's intent forward: true → defaults (nothing to
    // change); false → set autoDenyProtected=true so they keep their
    // modal-less experience.
    if (typeof userData.hookInstrumentation === "boolean" &&
        userData.protectedMode === undefined &&
        userData.autoDenyProtected === undefined) {
      if (userData.hookInstrumentation === false) {
        this.settings.protectedMode = true;
        this.settings.autoDenyProtected = true;
      }
      // hookInstrumentation=true maps to defaults (protectedMode=true,
      // autoDenyProtected=false) — no explicit assignment needed.
    }
    delete this.settings.hookInstrumentation;

    // v1.0.0: providerPreference values were renamed from transport-
    // tied ("sdk" / "cli") to product-tied identifiers so future
    // providers can be added without collision:
    //   "sdk" → "anthropic-api"
    //   "cli" → "claude-code"
    //   "auto" unchanged
    // Migration carries the user's existing preference forward so no
    // one has to reconfigure on upgrade.
    if (this.settings.providerPreference === "sdk") {
      this.settings.providerPreference = "anthropic-api";
    } else if (this.settings.providerPreference === "cli") {
      this.settings.providerPreference = "claude-code";
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

module.exports = GryphonPlugin;
