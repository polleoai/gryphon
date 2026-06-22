/**
 * Gryphon — Claude chat for Obsidian.
 *
 * Standalone chat plugin. No knowledge base, no ingest pipeline, no MCP
 * tools. Just a conversation with Claude (via the Anthropic API or an
 * optional locally-installed Claude CLI) that can read/edit vault files
 * and use the standard chat tools.
 */

const { Plugin, PluginSettingTab, Setting, Notice, Modal, setTooltip } = require("obsidian") as typeof import("obsidian");
const path = require("path") as typeof import("path");
const { GryphonChatView } = require("./chat-view");
// Portable settings renderer (issue #14). The Provider + Defaults config zone
// lives in settings-view.ts so consumers can render the same fields without
// hand-mirroring rows (which drifted and dropped the API-key inputs). The tab
// delegates its shared render helpers to the same module for a single source.
const { renderGryphonSettings, renderSectionHeading, descToTooltip } = require("./settings-view");
const { DEFAULT_SETTINGS, MODEL_ALIAS_MIGRATION, DEFAULT_PROTECTED_PATHS, DEFAULT_PROTECTED_COMMANDS } = require("./constants");
const { SkillRegistry } = require("./skills");
const {
  isObsidianRestApiUrl,
  buildRestApiDenyReason,
  RestApiTurnCounter,
} = require("./rest-api-policy");
const { buildDenyReason } = require("@gryphon/protect");
const {
  PermissionIPCServer,
  defaultSocketPath,
} = require("@gryphon/protect");
const { attackDetector } = require("@gryphon/protect");
const { ProvenanceStore } = require("@gryphon/protect");
const { sweepGryphonOrphans } = require("@gryphon/protect");

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
  declare plugin: any;
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

    // The portable config zone (Provider + Defaults) is drawn by the shared,
    // host-agnostic renderer (issue #14) so consumers render the exact same
    // fields instead of hand-mirroring rows (which drifted and dropped the
    // API-key inputs). onRerender re-runs display() so the Gryphon-only zone
    // below (Security / provenance / diagnostics) re-renders on provider
    // switch too.
    renderGryphonSettings(this.plugin, containerEl, {
      chrome: true,
      onRerender: () => this.display(),
    });

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
      (cleanBtn as any).addEventListener("click", async () => {
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
    // Delegate to the shared module helper (issue #14) so the standalone tab
    // and embedding consumers render identical section headings. `this.plugin`
    // supplies the settings/saveSettings the master-toggle path needs.
    return renderSectionHeading(parentEl, opts, this.plugin);
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
    // Delegate to the shared module helper (issue #14) — single source for the
    // info-icon affordance across the standalone tab and embedding consumers.
    return descToTooltip(setting, tooltipText);
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
  declare _activeSettingTab: any;
  declare _events: any;
  declare _forceFreshSpawnByProvider: any;
  declare _ipcSocketPath: string | null;
  declare _restApiCounter: any;
  declare settings: any;
  declare _sessionFlags: any;
  declare _taintedSessions: any;
  declare hostAdapter: any;
  declare ipcServer: any;
  declare provenanceStore: any;
  declare skillRegistry: any;
  async onload() {
    // Mutual exclusivity: if any plugin that embeds Gryphon is loaded,
    // defer to it to avoid duplicate view/ribbon registration.
    for (const hostId of GRYPHON_HOST_PLUGIN_IDS) {
      if ((this.app as any).plugins.enabledPlugins.has(hostId)) {
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

    // Sessions whose JSONL/transcript carries a Gryphon protected-deny
    // result. CLI providers (codex-cli, gemini-cli, claude-code) check
    // and CONSUME this set before deciding to `--resume <id>` on the
    // next send: if the prior turn ended with a protected deny, the
    // resumed context would let the model echo the canonical deny copy
    // without actually re-issuing the tool call (no hook fires, no
    // modal). Forcing a fresh spawn drops that tainted history. Cleared
    // on unload. User report 2026-05-03.
    this._taintedSessions = new Set();

    // Issue #33: per-CLI-provider "force fresh next spawn" signal.
    // Parallel safety net to `_taintedSessions` (which keys by raw
    // session_id) — but session_id matching has proved fragile in
    // practice: a Codex thread_id rotation, a hook input that omits
    // session_id, or a CLI that resumes a session with a different
    // internal id all leave taint orphaned and the next spawn resumes
    // on a poisoned transcript. This Set keys ONLY by provider kind
    // ("codex-cli" / "gemini-cli" / "claude-code") so any CLI provider
    // whose hook reported a protected deny is forced to spawn fresh
    // next time, regardless of which session id we have. One-shot per
    // entry — consumed at the start of the next spawn for that kind.
    this._forceFreshSpawnByProvider = new Set();

    // F4 (v1.7.0): per-turn GET counter for the Obsidian REST API. When
    // `obsidianRestApiPolicy === "allowed"`, every WebFetch the LLM
    // issues against 127.0.0.1:27124 increments this; the first turn
    // that crosses `restApiWarnThreshold` surfaces a one-time toast.
    // `_resetRestApiCounter()` runs on every user send (wired from
    // chat-view) and on /new / /clear.
    this._restApiCounter = new RestApiTurnCounter({
      threshold: typeof this.settings.restApiWarnThreshold === "number"
        ? this.settings.restApiWarnThreshold
        : 50,
      onWarn: (count) => this._onRestApiThresholdCrossed(count),
    });

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
        const { Notice } = require("obsidian") as typeof import("obsidian");
        new Notice(
          `Gryphon: IPC server failed to start (${(e && e.message) || e}). ` +
          `Claude Code mode will run with basic pattern enforcement only (no Unicode ` +
          `normalization). Reload Obsidian (Cmd/Ctrl+P → "Reload app without ` +
          `saving") to retry.`,
          15000,
        );
      } catch (_) { /* obsidian unavailable in tests */ }
    }

    // Single shared HostAdapter instance for the entire plugin session.
    // Passed to createProvider() and createProtectionContext() so runtime/
    // protect internals stay headless and never require("obsidian") directly.
    const { ObsidianHostAdapter } = require("./obsidian-host-adapter");
    this.hostAdapter = new ObsidianHostAdapter();

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
      // eslint-disable-next-line obsidianmd/commands/no-plugin-id-in-command-id -- stable command id; renaming it would silently break users' existing hotkey bindings
      id: "open-gryphon",
      // eslint-disable-next-line obsidianmd/commands/no-plugin-name-in-command-name -- product name kept intentionally in the command title
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
      // eslint-disable-next-line obsidianmd/commands/no-plugin-id-in-command-id -- stable command id; renaming it would silently break users' existing hotkey bindings
      id: "quote-highlight-into-gryphon",
      // eslint-disable-next-line obsidianmd/commands/no-plugin-name-in-command-name -- product name kept intentionally in the command title
      name: "Quote highlighted text into Gryphon chat",
      callback: async () => {
        const picked = this._pickSelectionForInjection();
        if (!picked) {
          new Notice("Gryphon: no text selected");
          return;
        }
        await this.activateView();
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
        const gryphonView = (leaves[0] && leaves[0].view) as any;
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
      (workspace as any).revealLeaf(leaf);
      window.requestAnimationFrame(() => {
        if ((leaf.view as any).inputEl) (leaf.view as any).inputEl.focus();
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
    const viewCache = leaves[0] && leaves[0].view && (leaves[0].view as any)._cachedSelection;
    if (viewCache && viewCache.text) {
      return { text: viewCache.text, file: viewCache.file };
    }
    // 2. Active editor selection (Source / Live Preview)
    const { MarkdownView } = require("obsidian") as typeof import("obsidian");
    const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (mdView && mdView.editor) {
      const sel = mdView.editor.getSelection();
      if (sel) return { text: sel, file: mdView.file || null };
    }
    // 3. Current window DOM selection (Reading mode at call time)
    const winSel = activeDocument.getSelection();
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
  /**
   * Issue #29: surface a one-shot status-bar notice in every open chat
   * view when the user changes Provider. The notice names the new
   * provider explicitly and tells the user how much prior conversation
   * will seed the next message — so a Provider switch doesn't silently
   * forward 100 turns of unrelated context to a different vendor.
   *
   * Skipped automatically when there's no prior conversation to forward
   * (first-time setup) — the chat view's helper checks _fullHistory.
   */
  _announceProviderChange(prevPreference, newPreference) {
    if (!prevPreference || !newPreference) return;
    if (prevPreference === newPreference) return;
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const view = leaf.view as any;
      if (view && typeof view._flashProviderChangeNotice === "function") {
        try { view._flashProviderChangeNotice(prevPreference, newPreference); }
        catch (e) { console.warn("[gryphon] provider-change notice failed:", e.message); }
      }
    }
  }

  _resetActiveSessions() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const view = leaf.view as any;
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
      // Bug #21 fix: provider preference changes need to update the
      // toolbar's model button in place — switching to openai-api /
      // google-api should immediately replace the Anthropic model
      // label with the Stage-N-pending hint.
      if (typeof view.refreshToolbarLabels === "function") {
        view.refreshToolbarLabels();
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
      const view = leaf.view as any;
      if (view && typeof view.addRefusalMessage === "function") {
        try { view.addRefusalMessage(reason); }
        catch (e) { console.warn("[gryphon] addRefusalMessage failed:", e.message); }
      }
    }
  }

  onunload() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if ((leaf.view as any).claudeProcess) (leaf.view as any).claudeProcess.abort();
    }
    // Belt-and-suspenders (R4): flush the subprocess registry so any CLI
    // child tree the runtime spawned — including one whose provider
    // reference was dropped (provider swap, closed view) before we could
    // abort() it — is reaped. Without this, a leaked `claude` + its MCP
    // grandchildren would orphan on plugin unload / Obsidian quit.
    try {
      const { killAllSubprocesses } = require("@gryphon/provider-runtime");
      if (typeof killAllSubprocesses === "function") {
        killAllSubprocesses("SIGTERM");
        // Escalate: a tree that ignores SIGTERM (a wedged MCP grandchild)
        // must not survive unload. The registry deregisters children that
        // already exited and killProcessTree skips exited pids, so this
        // SIGKILL sweep only hits genuine survivors. Disabling the plugin
        // does not tear down the renderer, so the timer still fires.
        window.setTimeout(() => {
          try { killAllSubprocesses("SIGKILL"); } catch (_) { /* best-effort */ }
        }, 2000);
      }
    } catch (_) { /* best-effort — never block unload */ }
    if (this.skillRegistry) this.skillRegistry.unload();
    // Close IPC server last so any in-flight hook request from a CC
    // process we just aborted gets a clean connection drop rather than
    // a stranded half-response.
    if (this.ipcServer) {
      try { void this.ipcServer.close(); } catch (_) { /* best-effort */ }
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
    const base = this.app && this.app.vault && this.app.vault.adapter && (this.app.vault.adapter as any).basePath;
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
    const { defaultSocketPath } = require("@gryphon/protect");
    const socketPath = this._ipcSocketPath || defaultSocketPath();
    try {
      await Promise.race([
        this.ipcServer.create(socketPath),
        new Promise((_, reject) =>
          window.setTimeout(() => reject(new Error("ipc-recovery-timeout")), timeoutMs),
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
    const fs = require("fs") as typeof import("fs");
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
      && (this.app.vault.adapter as any).basePath) || null;
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
      table.setCssStyles({ width: "100%", fontSize: "12px", borderCollapse: "collapse" });
      const head = table.createEl("tr");
      for (const h of ["Path", "Source", "Origin", "Tagged at"]) {
        const th = head.createEl("th", { text: h });
        th.setCssStyles({ textAlign: "left", padding: "4px 8px", borderBottom: "1px solid var(--background-modifier-border)" });
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
          td.setCssStyles({ padding: "4px 8px", verticalAlign: "top", wordBreak: "break-all" });
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
    const vaultRoot = this.app && this.app.vault && this.app.vault.adapter && (this.app.vault.adapter as any).basePath;
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
    // Normalize the incoming tool name to the Claude-Code vocabulary
    // for downstream branching. Different CLIs name the same tool
    // differently (Gemini: run_shell_command; Codex: command_execution
    // for shells), and this branch checks `tool === "Bash"` etc. by
    // name. Without normalization, a Gemini hook delivering a shell
    // command would skip the isMutating branch, derive the wrong
    // `kind`, and the modal would fail to render — manifesting to the
    // user as "no approve/deny modal but deny still happened" via the
    // fallback deny copy. classification.tool already carries the
    // normalized form (the classifier uses the same alias table); we
    // use that when classification fired, else normalize the raw name
    // here as a defensive default.
    const canonicalTool =
      (classification && classification.tool) ||
      attackDetector.normalizeToolName(tool) ||
      tool;
    const isMutating =
      canonicalTool === "Bash" || canonicalTool === "PowerShell" ||
      canonicalTool === "Write" || canonicalTool === "Edit";

    // F4 (v1.7.0): Obsidian REST API access policy. Runs BEFORE the
    // read-only allow path so the deny actually lands in claude-code
    // mode (where CC's built-in WebFetch is otherwise unrestricted on
    // loopback — unlike our SDK WebFetch which already refuses 127.0.0.1
    // via SSRF defense). When the policy is "allowed", we still count
    // every REST GET so the >threshold toast can fire if the LLM falls
    // into enumeration patterns.
    if (canonicalTool === "WebFetch") {
      const policyResult = this._applyRestApiPolicy(input);
      if (policyResult) return policyResult;
    }

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

    const { action, target } = _deriveActionTarget(canonicalTool, input);
    const kind = (canonicalTool === "Bash" || canonicalTool === "PowerShell") ? "exec" : "fileEdit";
    let gateResult;
    try {
      gateResult = await attackDetector.gate(classification, {
        ctx, action, target, detail: null, kind,
        // Allow the gate to use the session cache. Protected ops
        // never cache in either direction — every retry of a
        // destructive op shows the modal so the user is the explicit
        // decision-maker each time. Non-protected file edits cache
        // per-target when the user ticks "Remember"; bash never
        // caches (per-command decisions).
        cacheable: true,
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
      // Single source of truth for the deny copy lives in
      // providers/shared/deny-copy.js. The conversational
      // descriptive form (action + target + category) is more
      // user-friendly than the older "This operation matches..."
      // generic form because it tells the user WHAT was blocked.
      // User report 2026-05-04.
      const protectedKind = (tool === "Bash" || tool === "PowerShell")
        ? "protected-exec"
        : "protected";
      displayReason = buildDenyReason({
        action,
        target,
        category: classification.category || null,
        kind: protectedKind,
      });
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

    const allow = !!(gateResult && gateResult.allow);

    // Mark the originating CLI session as tainted on any protected
    // deny so the next turn skips --resume. Without this, the prior
    // canonical deny copy stays in the resumed transcript and the
    // model on the next turn just echoes it WITHOUT calling the tool
    // again — looking to the user like an "auto-deny" since no modal
    // appears (the hook never fires because the model never tried).
    // We taint only on classification-driven (protected) denies; a
    // user-modal deny on a non-protected op doesn't need to break
    // resume — the user already saw the modal and chose decline.
    if (!allow && classification && req && typeof req.sessionId === "string" && req.sessionId) {
      this._taintedSessions.add(req.sessionId);
    }

    // Issue #33: also mark the CLI provider that emitted this hook for
    // a fresh next spawn — robust to session_id mismatches (the hook
    // input may not include session_id, or it may not match what the
    // provider tracks internally). Without this, repeated denies on
    // the same provider can leave a poisoned resume transcript that
    // makes the model echo the prior deny copy without re-issuing the
    // tool call, so no modal fires on the third attempt.
    if (!allow && classification && req && typeof req.provider === "string" && req.provider) {
      this._forceFreshSpawnByProvider.add(req.provider);
    }

    return {
      decision: allow ? "allow" : "deny",
      reason: displayReason,
      matchedPattern: classification ? classification.matchedPattern : undefined,
      category: classification ? classification.category : undefined,
    };
  }

  /**
   * F4 (v1.7.0): apply the Obsidian REST API policy to a WebFetch
   * classify call. Returns a final `{decision, reason}` to short-circuit
   * the normal classify path when the URL targets the obsidian-local-
   * rest-api plugin (so the deny lands without going through the rest
   * of the gate logic), or returns null to let normal handling proceed
   * for any WebFetch that isn't pointed at the REST plugin.
   */
  _applyRestApiPolicy(input) {
    const url = input && typeof input.url === "string" ? input.url : "";
    if (!isObsidianRestApiUrl(url)) return null;
    const policy = this.settings && this.settings.obsidianRestApiPolicy;
    if (policy === "allowed") {
      try {
        this._restApiCounter && this._restApiCounter.note();
      } catch (e) {
        // The counter is arithmetic + callback dispatch; the callback
        // has its own catch. The only way we land here is a developer
        // bug after a refactor — surface to console so it's not silent.
        console.error("[gryphon] rest-api counter note failed:", e);
      }
      return { decision: "allow" };
    }
    // "blocked" (default) and any unrecognized value → deny. The reason
    // string is the same text the model surfaces to the user; we keep
    // it short and instructive so the model doesn't paraphrase away
    // the "use vault-native search" recovery path.
    return { decision: "deny", reason: buildRestApiDenyReason() };
  }

  /**
   * F4 (v1.7.0): fires once per turn when REST API GET count crosses
   * `restApiWarnThreshold`. Surfaces an Obsidian Notice and emits a
   * workspace event so chat-view can pin a visible warning to the
   * current turn. Swallows errors — the warning is best-effort UX, not
   * a security guarantee.
   */
  _onRestApiThresholdCrossed(count) {
    try {
      const { Notice } = require("obsidian") as typeof import("obsidian");
      new Notice(
        `Gryphon: the model has issued ${count} Obsidian REST API GETs ` +
        `this turn. This pattern usually means enumeration — consider ` +
        `interrupting and asking it to use vault search instead.`,
        12000,
      );
    } catch (e) {
      // Headless tests don't have a real Notice constructor — silent
      // OK there. In live Obsidian a failure here means a regression
      // is silently hiding the warning the policy exists to deliver;
      // log so the dev tools console shows the gap.
      console.error("[gryphon] rest-api warning Notice failed:", e);
    }
    // The Notice above is the canonical signal. A workspace event was
    // considered for pinning a per-turn banner inside chat-view, but no
    // listener was wired in v2.0 — removed to keep the surface honest.
    // If/when a chat-view banner lands, re-add a `workspace.trigger`
    // here with the listener side checked in at the same time.
  }

  /**
   * F4 (v1.7.0): reset the per-turn REST GET counter. Called by
   * chat-view on every user send and on /new / /clear.
   */
  _resetRestApiCounter() {
    if (this._restApiCounter) this._restApiCounter.reset();
  }

  /**
   * Returns true if the given raw CLI session id was marked tainted
   * by a prior protected-deny in this plugin lifetime, AND removes it
   * from the set (one-shot). Provider adapters call this before
   * deciding whether to pass `--resume <id>` on a fresh spawn.
   */
  consumeTaintedSession(rawSessionId) {
    if (!rawSessionId || typeof rawSessionId !== "string") return false;
    if (!this._taintedSessions.has(rawSessionId)) return false;
    this._taintedSessions.delete(rawSessionId);
    return true;
  }

  /**
   * Issue #33: returns true if the named CLI provider had a protected
   * deny since its last spawn AND removes the entry. Provider adapters
   * call this in their pre-spawn block — alongside the older
   * `consumeTaintedSession` — to force a fresh spawn even when the
   * session_id-based check would miss (orphaned taint from a CLI that
   * rotated thread ids, a hook input with no session_id, etc.).
   */
  consumeForceFreshSpawn(providerKind) {
    if (!providerKind || typeof providerKind !== "string") return false;
    if (!this._forceFreshSpawnByProvider.has(providerKind)) return false;
    this._forceFreshSpawnByProvider.delete(providerKind);
    return true;
  }

  async loadSettings() {
    // Keep the raw user-saved data before merging with defaults. Migration
    // needs it to distinguish "user explicitly set X" from "default filled
    // X in" — Object.assign collapses those two cases into the same value.
    const userData = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, userData);
    this._migrateSettings(userData);
    this._dropStalePerReloadSessionIds();
  }

  /**
   * Drop `lastSessionId` for providers whose CLI-side session state can
   * become stale across plugin reloads.
   *
   * Why this exists: Codex CLI and Gemini CLI bake the sandbox mode and
   * approval policy into the session at SPAWN time. Subsequent
   * `codex exec resume <id>` invocations inherit those settings — there
   * is no API to override them on resume. So if Gryphon ships an update
   * that changes how it maps `permissionMode` to the CLI's sandbox
   * (e.g. v1.3.0 → Stage 5 dispatcher rewiring), every existing chat
   * stays stuck on the OLD config until the user manually starts a new
   * conversation. The user-reported "delete from read-only session"
   * error on 2026-05-03 was exactly this trap.
   *
   * Chat history is preserved unconditionally — it lives in
   * chat-history.json under each view's storage, separate from
   * `settings.lastSessionId`. Dropping the session id only affects what
   * the next `send()` passes to the CLI as `--resume`; the chat-view's
   * stored messages array is untouched, and the new spawn renders the
   * full transcript locally.
   *
   * Provider matrix:
   *   - claude-code (UUID)         → KEEP. CC's `--resume` re-streams
   *                                   the full conversation context to
   *                                   the model, which the user wants
   *                                   to preserve across reloads.
   *   - SDK ("sdk-*", etc.)        → KEEP. Stateless — the session id
   *                                   is just a chat-view bookkeeping
   *                                   tag, not a server-side handle.
   *   - codex-cli ("codex-cli-*")  → DROP. Server-side state may be
   *                                   stale (sandbox baked in at spawn).
   *   - gemini-cli ("gemini-cli-*")→ DROP. Same reason as codex-cli.
   */
  _dropStalePerReloadSessionIds() {
    const sid = this.settings && this.settings.lastSessionId;
    if (typeof sid !== "string" || !sid) return;
    if (sid.startsWith("codex-cli-") || sid.startsWith("gemini-cli-")) {
      console.log(
        `[gryphon] dropping stale CLI lastSessionId on plugin load: ${sid} ` +
        `(chat history preserved; next message starts a fresh CLI session ` +
        `to pick up any sandbox/hook config changes from the new plugin build)`,
      );
      this.settings.lastSessionId = null;
    }
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
  _migrateSettings(userData: any = {}) {
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

    // v1.7.0: drop alias model values in favor of concrete model IDs.
    // The claude-code CLI used to map `sonnet` → "latest Sonnet" at spawn
    // time, but on boxes whose installed CLI predates Sonnet 4.6 the
    // alias still resolves to Sonnet 4.5 (200K context) — causing
    // "Prompt is too long" errors in long-context vaults.
    // Pinning to concrete IDs eliminates that drift.
    //
    // Carry intent forward:
    //   haiku    → claude-haiku-4-5     (fast)
    //   sonnet   → claude-sonnet-4-6    (balanced, now 1M)
    //   opus     → claude-opus-4-7      (most capable, 1M)
    //   opus[1m] → claude-opus-4-7      (same — Opus 4.7 is intrinsically 1M)
    const aliased = this.settings.model;
    if (typeof aliased === "string"
        && Object.prototype.hasOwnProperty.call(MODEL_ALIAS_MIGRATION, aliased)) {
      this.settings.model = MODEL_ALIAS_MIGRATION[aliased];
    }
  }

  /**
   * F1 Stage D (v1.7.0) — self-tuning context-projection calibration.
   *
   * After each turn, chat-view compares the pre-send projected total
   * against the actual `contextTokens` CC reported back, and calls this
   * with `actual - projected`. We keep a rolling buffer of the last 20
   * deltas per vault and return their mean from
   * `getProjectionCalibrationDelta()`. The projection summarizer adds
   * the mean to its raw heuristic, so over time the chip converges to
   * the right number for this user's actual memory + skill + tool mix
   * without us having to predict it from constants.
   *
   * Persisted via `saveData` directly (NOT saveSettings) to avoid
   * firing `gryphon:settings-changed` — that would re-trigger the
   * projection recompute we just calibrated against, in a feedback
   * loop.
   */
  recordProjectionCalibrationSample(deltaTokens) {
    if (!Number.isFinite(deltaTokens)) return;
    const MAX = 20;
    const prior = Array.isArray(this.settings._projectionCalibrationDeltas)
      ? this.settings._projectionCalibrationDeltas
      : [];
    const buf = prior.slice();
    buf.push(deltaTokens);
    while (buf.length > MAX) buf.shift();
    this.settings._projectionCalibrationDeltas = buf;
    // saveData returns a Promise; swallow both synchronous throws and
    // async rejections so calibration is best-effort either way. Disk
    // full / EROFS shouldn't surface during chat.
    try {
      const p: any = this.saveData(this.settings);
      if (p && typeof p.then === "function") {
        p.then(() => {}, () => {});
      }
    } catch { /* best-effort */ }
  }

  /**
   * Mean of the recorded deltas, rounded to the nearest token. Returns
   * 0 when no samples have been recorded yet (fresh vault).
   */
  getProjectionCalibrationDelta() {
    const buf = this.settings._projectionCalibrationDeltas;
    if (!Array.isArray(buf) || buf.length === 0) return 0;
    let sum = 0;
    let n = 0;
    for (const v of buf) {
      if (Number.isFinite(v)) { sum += v; n += 1; }
    }
    return n === 0 ? 0 : Math.round(sum / n);
  }

  async saveSettings() {
    await this.saveData(this.settings);
    // Issue #40: notify any open GryphonChatView instances (and
    // consumer plugins listening) that settings changed, so they can
    // refresh toolbar badges + invalidate any settings-derived cached
    // state. Without this, badges stay frozen at the values present
    // when the view was first opened.
    //
    // Round 4 review (SFH-3 / CR-F4-1): wrap in try/catch so a buggy
    // consumer-plugin listener can't reject saveSettings (the persisted
    // data is already on disk; we don't want a listener exception to
    // surface as "settings save failed"). Also surface unexpected
    // missing-API as console.error rather than a silent no-op — an
    // Obsidian update that renames `workspace.trigger` should be
    // visible, not invisible.
    const w = this.app && this.app.workspace;
    if (w && typeof w.trigger === "function") {
      try {
        w.trigger("gryphon:settings-changed", this.settings);
      } catch (e) {
        console.error(
          `[gryphon] gryphon:settings-changed listener threw — settings DID persist. ` +
          `Listener error: ${(e && e.message) || e}`,
        );
      }
    } else if (this.app) {
      // app exists but workspace.trigger doesn't — unexpected in real Obsidian.
      // Headless tests deliberately omit `app` entirely (the first branch above
      // matches via the `&&`), so this only fires when the API surface drifts.
      console.error(
        "[gryphon] this.app.workspace.trigger missing — toolbar badges will " +
        "not refresh until next view open. Possible Obsidian API drift.",
      );
    }
  }
}

module.exports = GryphonPlugin;
