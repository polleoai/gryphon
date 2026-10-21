/** The closed set. `autoDenyProtected` is NOT here: both values enforce. */
declare const WEAKENING_KEYS: readonly ["protectedMode", "permissionMode", "protectedPathsEnabled", "protectedCommandsEnabled", "blockPackageInstall", "protectedPathsDisabled", "protectedCommandsDisabled", "claudeCodeInheritUserConfig", "obsidianRestApiPolicy"];
type WeakeningKey = typeof WEAKENING_KEYS[number];
type SecurityValues = Partial<Record<WeakeningKey, unknown>>;
type SecurityScope = {
    vaultKey: string;
    hostId: string;
};
type Source = "override" | "machine" | "default";
/** What each weakening key holds once validateSecurityValue() accepts it. */
interface SecurityValueTypes {
    protectedMode: boolean;
    permissionMode: string;
    protectedPathsEnabled: boolean;
    protectedCommandsEnabled: boolean;
    blockPackageInstall: boolean;
    protectedPathsDisabled: string[];
    protectedCommandsDisabled: string[];
    claudeCodeInheritUserConfig: boolean;
    obsidianRestApiPolicy: "blocked" | "allowed";
}
declare const DEFAULTS: Readonly<Record<WeakeningKey, unknown>>;
/** Issue #30: the CLI binary paths — machine-scoped, never read from data.json. */
declare const EXECUTABLE_KEYS: readonly ["claudePath", "codexPath", "geminiCliPath", "antigravityPath"];
type ExecutableKey = typeof EXECUTABLE_KEYS[number];
declare const CLI_PATH_KEY_BY_KIND: Readonly<Record<string, ExecutableKey>>;
declare function isExecutableKey(key: unknown): key is ExecutableKey;
declare function isWeakeningKey(key: unknown): key is WeakeningKey;
/**
 * `{ ok: true, value }` with the normalized value, or `{ ok: false, reason }`.
 * A `*Disabled` list keeps only entries naming a built-in pattern: disabling
 * a pattern that doesn't exist does nothing, so dropping it changes nothing.
 */
declare function validateSecurityValue(key: unknown, value: unknown): {
    ok: true;
    value: unknown;
} | {
    ok: false;
    reason: string;
};
/** True when `value` removes protection relative to the default. */
declare function isWeakening(key: WeakeningKey, value: unknown): boolean;
declare function hashValue(value: unknown): string;
declare function securitySettingsFilePath(opts?: {
    platform?: string;
    env?: Record<string, string | undefined>;
    homedir?: string;
}): string;
declare class SecurityScopeUnavailableError extends Error {
    missing: "app" | "basePath" | "hostId";
    constructor(missing: "app" | "basePath" | "hostId");
}
/**
 * The store scope for a host, or why there isn't one. Uses the host's
 * `app.vault.adapter` base path and its manifest id — never
 * `_vaultRoot()`, which embedders don't have.
 */
declare function describeSecurityScope(input?: {
    app?: unknown;
    hostPlugin?: unknown;
    hostId?: string;
}): {
    scope: SecurityScope;
    missing: null;
} | {
    scope: null;
    missing: "app" | "basePath" | "hostId";
};
declare function resolveSecurityScope(input?: {
    app?: unknown;
    hostPlugin?: unknown;
    hostId?: string;
}): SecurityScope | null;
declare function scopeKey(scope: SecurityScope | null): string | null;
/**
 * Register a sink for store read errors (the plugin shows a Notice). Each
 * distinct error is reported once per file version. Returns an unsubscribe.
 */
declare function onSecurityStoreError(fn: (message: string, file: string) => void): () => void;
type TamperSink = (reverted: Reverted[], error: unknown, info?: "record-started") => void;
/** Changes undone (or that couldn't be) outside a reply's own check. */
declare function onSecurityStoreTamper(fn: TamperSink): () => void;
/** This scope's confirmed values (validated). */
declare function readMachineSecuritySettings(scope: SecurityScope, opts?: {
    file?: string;
}): SecurityValues;
/**
 * Store a value for this scope. Call ONLY from an explicit user gesture on
 * this machine. Validates; throws on an unknown key or an invalid value.
 * Writes in both directions: turning protection back on is stored too, so
 * a stale weaker value can't keep winning.
 */
declare function setMachineSecuritySetting(scope: SecurityScope, key: WeakeningKey, value: unknown, opts?: {
    file?: string;
    now?: Date;
}): void;
/** "Keep protections on": stay quiet until data.json brings a different value. */
declare function dismissVaultSecuritySuggestion(scope: SecurityScope, key: WeakeningKey | ExecutableKey, value: unknown, opts?: {
    file?: string;
}): void;
/**
 * Validate a consumer's `securityOverrides`. Unknown keys and invalid values
 * are logged and ignored (they resolve as if absent).
 */
declare function sanitizeSecurityOverrides(overrides: unknown, label?: string): SecurityValues;
/** The frozen snapshot effectiveSecuritySettings() returns. */
type EffectiveSecurity = Readonly<SecurityValueTypes & {
    autoDenyProtected: boolean;
    protectedPathsCustom: string[];
    protectedCommandsCustom: string[];
    source: Partial<Record<WeakeningKey, Source>>;
    unconfirmed: WeakeningKey[];
    scopeAvailable: boolean;
    paths: Partial<Record<ExecutableKey, string>>;
    unconfirmedPaths: ExecutableKey[];
}>;
/**
 * The frozen snapshot every enforcement site reads: the nine weakening
 * keys, plus the strengthen-only inputs copied from `settings`
 * (`autoDenyProtected` and the custom pattern lists), plus metadata:
 *   source       — where each weakening key's value came from
 *   unconfirmed  — weakening data.json values not confirmed on this machine
 *   scopeAvailable — false when no store scope exists (reads failed closed)
 */
declare function effectiveSecuritySettings(settings: unknown, scope: SecurityScope | null, overrides?: SecurityValues & {
    paths?: unknown;
}, opts?: {
    file?: string;
    detect?: (kind: string) => string | null;
}): EffectiveSecurity;
/** Just the nine weakening values of a snapshot (for comparisons / logs). */
declare function securityValuesOf(sec: unknown): SecurityValues;
/**
 * The security inputs for an enforcement call. `holder.security` (the
 * snapshot) wins. Without one, an explicit `holder.settings` — a config the
 * caller's code supplied — is used: that's the library contract for
 * headless callers.
 *
 * Issue #30 (G4): `holder.plugin.settings` is NOT an input. That object is
 * the host's data.json, which travels with the vault. A caller that passes
 * only `plugin` gets the protected defaults plus the strengthen-only keys
 * (autoDenyProtected, the custom pattern lists), frozen, and one warning
 * per process. Gryphon's own call sites always pass a snapshot.
 */
declare function securityInputsOf(holder: unknown): Record<string, unknown>;
type CliPathRejectReason = "relative" | "missing" | "not-a-file" | "not-executable" | "inside-vault" | "too-old";
declare class CliPathRejectedError extends Error {
    key: ExecutableKey;
    value: string;
    reason: CliPathRejectReason;
    constructor(key: ExecutableKey, value: string, reason: CliPathRejectReason);
}
/**
 * Validate a configured CLI path. Returns the configured path and its
 * realpath (the thing to spawn), or why it can't be used. The configured
 * path AND its realpath must both be outside the vault: an in-vault symlink
 * to an outside binary could be re-pointed by sync.
 */
declare function validateCliPath(value: unknown, vaultRoot: string | null | undefined, platform?: string): {
    ok: true;
    configured: string;
    real: string;
} | {
    ok: false;
    reason: CliPathRejectReason;
};
/**
 * Store a CLI path for this scope, from a user gesture on this machine
 * (Settings, the one-time confirm). Stores the CONFIGURED path (a symlink
 * stays a symlink, so a CLI's self-update doesn't strand it); validates on
 * write and again on every resolve. `null` / "" clears it. Throws
 * CliPathRejectedError with the reason when the path can't be used.
 */
declare function setMachineCliPath(scope: SecurityScope, key: ExecutableKey, value: string | null, opts?: {
    file?: string;
}): void;
/** Validate an embedder's code-set `securityOverrides.paths`. */
declare function sanitizeCliPathOverrides(paths: unknown): Partial<Record<ExecutableKey, string>>;
type ResolvedCliPath = {
    path: string | null;
    source: "override" | "machine" | "detected" | null;
    version: string | null;
    rejected?: {
        key: ExecutableKey;
        value: string;
        reason: CliPathRejectReason;
    };
    unavailable?: "not-found" | "too-old";
};
/**
 * Issue #30: the ONE resolver every CLI spawn and probe goes through.
 * Synchronous; never throws. Order:
 *   1. `overrides.paths[key]` — set by the embedder's code;
 *   2. this machine's store for (vault, hostId) — a user gesture here;
 *   3. detection (find*Binary).
 * Each candidate is validated (absolute; realpath is an executable regular
 * file; neither inside the vault) BEFORE its `--version` is probed, so an
 * unvalidated binary is never executed. `path` is the realpath computed in
 * this call — spawn exactly that. A rejected candidate comes back in
 * `rejected` (logged once) and resolution falls through. data.json is never
 * consulted. No hostId (an embedder that hasn't pinned one) → the store is
 * skipped.
 */
declare function resolveCliPath(kind: string, ctx?: {
    app?: unknown;
    hostPlugin?: unknown;
    hostId?: string;
    overrides?: {
        paths?: unknown;
    } | null;
    detect?: (kind: string) => string | null;
}): ResolvedCliPath;
type StoreSnapshot = {
    file: string;
    raw: string | null;
    seq: number;
};
/** Turn start: remember the store's content and the ledger position. */
declare function snapshotSecurityStore(opts?: {
    file?: string;
}): StoreSnapshot;
type Reverted = {
    vaultKey: string;
    hostId: string;
    key: string;
};
declare function checkSecurityStoreTamper(before: StoreSnapshot, judged?: string | null): {
    changed: boolean;
    reverted: Reverted[];
};
export { WEAKENING_KEYS, EXECUTABLE_KEYS, CLI_PATH_KEY_BY_KIND, isExecutableKey, CliPathRejectedError, validateCliPath, setMachineCliPath, sanitizeCliPathOverrides, resolveCliPath, snapshotSecurityStore, checkSecurityStoreTamper, onSecurityStoreTamper, DEFAULTS as SECURITY_DEFAULTS, isWeakeningKey, isWeakening, validateSecurityValue, hashValue, securitySettingsFilePath, SecurityScopeUnavailableError, describeSecurityScope, resolveSecurityScope, scopeKey, onSecurityStoreError, readMachineSecuritySettings, setMachineSecuritySetting, dismissVaultSecuritySuggestion, sanitizeSecurityOverrides, effectiveSecuritySettings, securityValuesOf, securityInputsOf, };
export type { SecurityScope, EffectiveSecurity, SecurityValueTypes, SecurityValues, StoreSnapshot, WeakeningKey, ExecutableKey };
