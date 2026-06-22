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
export {};
