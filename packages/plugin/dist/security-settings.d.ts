/**
 * Security settings, host side (issue #29, Design rev 3).
 *
 * Every UI write of a weakening key — the toolbar picker, `/perm`, the REST
 * chip, Settings (Gryphon's own tab and the host-agnostic renderer an
 * embedder draws), the confirm prompt — goes through `applySecuritySetting`.
 * It writes the machine-local store in `@polleoai/gryphon-protect` (outside the
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
import { Modal } from "obsidian";
import type { App } from "obsidian";
import { securitySettings } from "@polleoai/gryphon-protect";
import type { SecurityScope, EffectiveSecurity } from "@polleoai/gryphon-protect";
type SecurityScopeResult = {
    scope: SecurityScope;
    missing: null;
} | {
    scope: null;
    missing: "app" | "basePath" | "hostId";
};
declare const WEAKENING_KEYS: readonly ["protectedMode", "permissionMode", "protectedPathsEnabled", "protectedCommandsEnabled", "blockPackageInstall", "protectedPathsDisabled", "protectedCommandsDisabled", "claudeCodeInheritUserConfig", "obsidianRestApiPolicy"], SecurityScopeUnavailableError: typeof securitySettings.SecurityScopeUnavailableError;
declare function cliPathLabel(key: string): string;
/** Issue #30: the CLI kind a path key belongs to. */
declare function cliKindForPathKey(key: string): string | null;
declare const SECURITY_CHANGED_EVENT = "gryphon:security-settings-changed";
type Host = {
    settings: Record<string, unknown>;
    saveSettings(): unknown;
    app?: App;
    manifest?: {
        id?: string;
        name?: string;
    };
};
type ApplyOpts = {
    app?: App;
    hostId?: string;
    overrides?: Record<string, unknown> | null;
};
/** Human label for a weakening key. */
declare function securityKeyLabel(key: string): string;
/** Human, display-safe rendering of a value a vault file requests. */
declare function describeSecurityValue(key: string, value: unknown): string;
declare function hostDisplayName(host: Host, hostId?: string | null): string;
declare function securityScopeFor(host: Host, opts?: ApplyOpts): SecurityScopeResult;
/** The effective snapshot for a host (what enforcement and badges read). */
declare function effectiveSecurityFor(host: Host, opts?: ApplyOpts): EffectiveSecurity;
/**
 * Write one weakening key from a user gesture on this machine.
 *   1. resolve the scope (throws SecurityScopeUnavailableError without one);
 *   2. validate; 3. write the store (both directions);
 *   4. mirror into host.settings + saveSettings() (display only);
 *   5. trigger `gryphon:security-settings-changed` on the workspace bus.
 * The caller's view tears down its live process (the spawn signature
 * carries the effective values, so a mismatch respawns on next message).
 */
declare function applySecuritySetting(host: Host, key: string, value: unknown, opts?: ApplyOpts): Promise<securitySettings.SecurityScope>;
/**
 * Issue #30: store a CLI binary path from a user gesture on this machine
 * (Settings row, the confirm prompt). Validates (throws CliPathRejectedError
 * with the reason), writes the machine store under the host's scope, mirrors
 * the value into the host's settings for display continuity (never a spawn
 * input), and announces the change. `value` "" / null clears it.
 */
declare function applyCliPathSetting(host: Host, key: string, value: string | null, opts?: ApplyOpts): Promise<securitySettings.SecurityScope>;
declare function reportCliPathRejected(rejected: {
    key: string;
    value: string;
    reason: string;
}): void;
declare function reportSecurityTamperReverted(reverted: Array<{
    hostId: string;
    key: string;
}>, providerLabel: string | null): void;
/**
 * R43-10: the turn-end check found a change to the security settings but
 * couldn't put it back. Nothing was undone, so the user must look.
 */
declare function reportSecurityTamperUndoFailed(providerLabel: string | null, e: unknown): void;
/** The Notice + log a caller shows when a security write fails. */
declare function reportSecurityWriteError(e: unknown): string;
declare function installSecurityStoreErrorNotice(): void;
/**
 * The confirm prompt: lists each unconfirmed key with the value the vault's
 * settings file asks for.
 *   Use these settings on this machine → applySecuritySetting for each key.
 *   Keep protections on → dismissed until data.json brings a different value.
 *   Esc / close → protections stay on for this app session only.
 */
declare class ConfirmVaultSecurityModal extends Modal {
    host: Host;
    securityScope: SecurityScope | null;
    keys: string[];
    pathKeys: string[];
    opts: ApplyOpts & {
        onDone?: (outcome: "confirmed" | "dismissed") => void;
    };
    constructor(app: App, host: Host, scope: SecurityScope | null, unconfirmed: string[], opts?: ApplyOpts & {
        onDone?: (outcome: "confirmed" | "dismissed") => void;
    }, unconfirmedPaths?: string[]);
    open(): void;
    _securityScope(): SecurityScope | null;
    _render(): void;
    confirm(): Promise<void>;
    keepProtections(): void;
}
/**
 * Open the confirm prompt if this host's scope has unconfirmed weakening
 * values and it hasn't been shown this session. `force` (the ⚠ badge click,
 * Settings' Confirm… row) reopens it regardless. Returns the modal or null.
 */
declare function maybePromptVaultSecurity(app: App, host: Host, opts?: ApplyOpts & {
    force?: boolean;
    onDone?: (o: "confirmed" | "dismissed") => void;
}): ConfirmVaultSecurityModal;
/** Test seam: forget which scopes were prompted this session. */
declare function _resetPromptedScopes(): void;
export { WEAKENING_KEYS, SECURITY_CHANGED_EVENT, SecurityScopeUnavailableError, applySecuritySetting, applyCliPathSetting, reportCliPathRejected, reportSecurityTamperReverted, reportSecurityTamperUndoFailed, cliPathLabel, cliKindForPathKey, reportSecurityWriteError, installSecurityStoreErrorNotice, securityScopeFor, effectiveSecurityFor, securityKeyLabel, describeSecurityValue, hostDisplayName, ConfirmVaultSecurityModal, maybePromptVaultSecurity, _resetPromptedScopes, };
