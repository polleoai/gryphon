/**
 * Security settings, host side (issue #29, Design rev 3).
 *
 * Every UI write of a weakening key — the toolbar picker, `/perm`, the REST
 * chip, Settings (Gryphon's own tab and the host-agnostic renderer an
 * embedder draws), the confirm prompt — goes through `applySecuritySetting`.
 * It writes the machine-local store in `@gryphon/protect` (outside the
 * vault), mirrors the value into the host's settings for display continuity
 * (never enforced), and announces the change on the workspace bus.
 *
 * `host` is the minimal embedding contract `{ settings, saveSettings, app?,
 * manifest? }`. The store scope comes from `app.vault.adapter` and an
 * explicit `hostId` or the host's code-set `securityHostId` — never
 * `manifest.id` (#30, G3); with no scope a write throws
 * `SecurityScopeUnavailableError` and the caller shows why. A confirm is
 * never dropped silently.
 */
export {};
