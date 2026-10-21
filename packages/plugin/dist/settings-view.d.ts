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
 * Security settings (issue #29): `claudeCodeInheritUserConfig`,
 * `obsidianRestApiPolicy` and `permissionMode` show their EFFECTIVE value
 * and write through `applySecuritySetting` (the machine-local store), never
 * straight into `hostPlugin.settings`. That needs the optional `app`
 * (vault path) and `manifest.id` (store namespace; or pass
 * `options.securityHostId`); without them the controls show protected
 * defaults and a write raises a visible error. `options.securityOverrides`
 * shows host-set keys disabled, "Set by <host>". `_vaultRoot()` is never
 * used for the security scope.
 *
 * The Gryphon-plugin-only zone (Security / Protected-Mode / provenance /
 * diagnostics) stays in `GryphonSettingTab` — it depends on `provenanceStore`,
 * `@polleoai/gryphon-protect`, and REST internals a generic host does not have.
 */
import { Setting } from "obsidian";
import type { App } from "obsidian";
/** The settings fields this renderer reads and writes (plus any other key). */
interface GryphonSettingsLike {
    [key: string]: unknown;
    providerPreference?: string;
    fallbackProviderPreference?: string;
    fallbackModel?: string;
    model?: string;
    effort?: string;
    anthropicApiKey?: string;
    openaiApiKey?: string;
    googleApiKey?: string;
    braveSearchApiKey?: string;
    autoCompactSdk?: boolean;
    autoRetryOnRateLimit?: boolean;
    useExactTokenCounting?: boolean;
    confirmOnContextOverflow?: boolean;
    openInMainTab?: boolean;
    connectionTimeoutMs?: number | null;
    maxReadFileSizeMb?: number;
}
/**
 * Host contract: `{ settings, saveSettings }` is required; everything else is
 * optional (see the module header).
 */
interface SettingsHost {
    settings: GryphonSettingsLike;
    saveSettings: () => Promise<void> | void;
    app?: App;
    manifest?: {
        id?: string;
        name?: string;
    };
    hostAdapter?: unknown;
    _resetActiveSessions?: () => void;
    _announceProviderChange?: (prev: string, next: string) => void;
}
/** `{ rerenderSelf, rerenderAll }` from the tab harness. */
interface TabCtx {
    rerenderSelf: () => void;
    rerenderAll: () => void;
}
interface TabDescriptor {
    id: string;
    label: string;
    render: (panelEl: HTMLElement, ctx: TabCtx) => void;
}
/** Issue #29/#30 security options threaded through the panels. */
interface SecurityRenderOpts {
    securityOverrides?: Record<string, unknown> | null;
    securityHostId?: string;
    rerender?: () => void;
}
interface RenderSettingsOptions extends SecurityRenderOpts {
    chrome?: boolean;
    extraTabs?: TabDescriptor[];
    initialTabId?: string;
    onTabChange?: (id: string) => void;
}
interface ModelOption {
    id: string;
    label: string;
}
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
declare function _resetModelForProvider(plugin: SettingsHost): string;
/**
 * Model dropdown options ([{id, label}]) for a fallback provider KIND (issue
 * #15). Mirrors the per-vendor lists the Default-model dropdown uses, so the
 * Fallback-model picker offers exactly the models that kind can serve.
 */
declare function _fallbackModelOptions(kind: string): ModelOption[];
/**
 * Model to pre-select for a fallback provider: that kind's own default when
 * it is offered, else the first option. Not simply `opts[0]` — dropdowns are
 * in registry order, so the first entry is the cheapest tier (Haiku) or,
 * for Codex, a model older clients reject.
 */
declare function _defaultFallbackModel(kind: string, opts: ModelOption[]): string;
/**
 * Which credential field key(s) the Setup panel must render for a provider
 * preference. Returns null for "auto"/unknown — the caller then renders the
 * collapsed all-credentials group. The string keys map to the per-credential
 * row renderers below.
 */
declare function _credentialFieldsFor(pref: string): string[] | null;
/**
 * Setup rows: quick-start callout + readiness chip + Provider dropdown +
 * provider-scoped credentials. (Fallback rows render separately, last in the
 * Models tab — see `renderFallbackRows`.)
 *
 * @param hostPlugin  minimal duck type `{ settings, saveSettings }`.
 * @param panelEl     element this panel owns and renders into.
 * @param ctx         `{ rerenderSelf, rerenderAll }` from the tab harness.
 * @param sec         issue #29/#30 `{ securityOverrides, securityHostId }` —
 *                    CLI-path rows write under that host's scope.
 */
declare function renderSetupPanel(hostPlugin: SettingsHost, panelEl: HTMLElement, ctx: TabCtx, sec?: SecurityRenderOpts): void;
/**
 * Fallback provider + model rows (issue #15). Rendered LAST in the Models tab —
 * after the primary provider/credentials AND the default model settings — so the
 * secondary failover choice never splits the primary model configuration.
 * Fallback-provider change re-renders the whole Models panel (`ctx.rerenderSelf`)
 * so the conditional Fallback-model row appears/updates.
 */
declare function renderFallbackRows(hostPlugin: SettingsHost, panelEl: HTMLElement, ctx: TabCtx): void;
/**
 * Remove the body-appended hover-tooltip singleton. Obsidian asks plugins to
 * clean up DOM they add to `document.body`; the standalone plugin calls this
 * from `onunload()`. Safe to call when nothing was ever shown (no-op).
 */
declare function disposeHoverTooltip(): void;
/**
 * Collapse a Setting row's description into a hover tooltip, attached to an
 * `(i)` info icon appended to the row's name span. Shared by the renderer and
 * (via delegation) by GryphonSettingTab's Gryphon-only zone so the info-icon
 * affordance is consistent across the whole settings tab.
 */
declare function descToTooltip(setting: Setting, tooltipText: string): Setting;
/**
 * Render a section heading. With no `toggleKey` it's a lightweight h3-style
 * div (Provider / Defaults / Diagnostics). With a `toggleKey` it renders as
 * an Obsidian Setting row carrying a master toggle bound to
 * `plugin.settings[toggleKey]` — used by the Gryphon-only Security zone, which
 * is why this helper takes `plugin` explicitly (the renderer's portable zone
 * only ever uses the no-toggle form).
 */
declare function renderSectionHeading(parentEl: HTMLElement, opts: {
    title: string;
    tooltip?: string;
    toggleKey?: string;
    onToggle?: (value: boolean) => void;
}, plugin: SettingsHost): HTMLElement | Setting;
/**
 * Issue #29: under a security control, the rows that explain its value:
 *   - set by the host plugin (securityOverrides) → "Set by <host>";
 *   - no security scope → "protections forced on";
 *   - the vault's settings file requests a weaker value not confirmed on
 *     this machine → "Vault file requests <value>, not confirmed on this
 *     machine — Confirm…", which opens the same prompt the chat view hosts.
 * Returns the row's Setting, or null when nothing needs explaining.
 */
declare function renderUnconfirmedSecurityRow(panelEl: HTMLElement, hostPlugin: SettingsHost, key: string, sec: SecurityRenderOpts | undefined): Setting | null;
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
 *                    - `securityOverrides` / `securityHostId` (issue #29):
 *                      the same values the host passes its chat view, so
 *                      both show the same effective security settings.
 */
declare function renderGryphonSettings(hostPlugin: SettingsHost, containerEl: HTMLElement, options?: RenderSettingsOptions | null): {
    activate: (id: string) => void;
};
/**
 * Advanced tab: optional Brave key + tuning toggles + connection timeout +
 * max file size. Niche knobs kept out of the primary Setup path.
 */
declare function renderAdvancedPanel(hostPlugin: SettingsHost, panelEl: HTMLElement, ctx: TabCtx, sec?: SecurityRenderOpts): void;
/**
 * Defaults tab: provider-aware Default model + Default effort + Default
 * permissions + Open-in-main-tab. (Per-session defaults, also reachable from
 * the chat toolbar.)
 */
declare function renderDefaultsPanel(hostPlugin: SettingsHost, panelEl: HTMLElement, _ctx: TabCtx | null, sec?: SecurityRenderOpts): void;
/**
 * Build the close-time warning shown when the user leaves the settings with a
 * selected provider that can't actually run (no key / no CLI). Returns the
 * notice string, or null when the selected provider IS usable (the happy path
 * stays silent). Pure — reads `plugin.settings` + the readiness kernel, no
 * network, no Notice — so it's unit-testable; the caller (`GryphonSettingTab.
 * hide()`) wraps it in `new Notice(...)`.
 */
declare function buildProviderUnreadyNotice(plugin: SettingsHost | null | undefined): string | null;
export { renderGryphonSettings, buildProviderUnreadyNotice, disposeHoverTooltip, renderSetupPanel, renderFallbackRows, renderAdvancedPanel, renderDefaultsPanel, _credentialFieldsFor, _resetModelForProvider, _fallbackModelOptions, _defaultFallbackModel, renderSectionHeading, descToTooltip, renderUnconfirmedSecurityRow, };
