import * as attackDetector from "./attack-detector";
import * as denyCopy from "./deny-copy";
import * as permissionIpcServer from "./permission-ipc-server";
import * as provenanceStore from "./provenance-store";
import * as tmpfileSweeper from "./tmpfile-sweeper";
import * as winSpawn from "./win-spawn";
import * as hookDispatcher from "./hook-dispatcher";
import * as ccDisallowTranslator from "./cc-disallow-translator";
import * as systemPromptHints from "./system-prompt-hints";
import * as injectionPatterns from "./injection-patterns";
import * as untrustedFraming from "./untrusted-framing";
import * as hookAdapters from "./hook-adapters";
import * as pathUtils from "./path-utils";
import * as permissionGate from "./permission-gate";
import * as constants from "./constants";
import * as mcpApprovals from "./mcp-approvals";
import * as storeGuard from "./store-guard";
import { patchTargets } from "./tool-aliases";
import * as securitySettings from "./security-settings-store";
export type { SecurityScope, EffectiveSecurity, SecurityValueTypes, SecurityValues, StoreSnapshot, WeakeningKey, ExecutableKey } from "./security-settings-store";
import { buildTrustOnlyOverlay } from "./hook-adapters/codex-cli";
export { attackDetector, denyCopy, permissionIpcServer, provenanceStore, tmpfileSweeper, winSpawn, hookDispatcher, ccDisallowTranslator, systemPromptHints, injectionPatterns, untrustedFraming, hookAdapters, pathUtils, permissionGate, constants, mcpApprovals, securitySettings, storeGuard, createProtectionContext, };
export declare const classify: typeof attackDetector.classify;
export declare const normalizeToolName: typeof attackDetector.normalizeToolName;
export declare const buildDenyReason: typeof denyCopy.buildDenyReason;
export declare const PermissionIPCServer: typeof permissionIpcServer.PermissionIPCServer;
export declare const defaultSocketPath: typeof permissionIpcServer.defaultSocketPath;
export declare const ProvenanceStore: typeof provenanceStore.ProvenanceStore;
export declare const sweepGryphonOrphans: typeof tmpfileSweeper.sweepGryphonOrphans;
export declare const buildDisallowedTools: typeof ccDisallowTranslator.buildDisallowedTools;
export declare const buildApprovalsStoreDenyGlobs: typeof ccDisallowTranslator.buildApprovalsStoreDenyGlobs;
export declare const resolveVaultPath: typeof pathUtils.resolveVaultPath;
export declare const PathOutsideVaultError: typeof pathUtils.PathOutsideVaultError;
export declare const resolveActivePatterns: typeof pathUtils.resolveActivePatterns;
export declare const checkPermission: typeof permissionGate.checkPermission;
export declare const setActiveProviderKindResolver: typeof permissionGate.setActiveProviderKindResolver;
export declare const setPermissionModalUi: typeof permissionGate.setPermissionModalUi;
export declare const WEAKENING_KEYS: readonly ["protectedMode", "permissionMode", "protectedPathsEnabled", "protectedCommandsEnabled", "blockPackageInstall", "protectedPathsDisabled", "protectedCommandsDisabled", "claudeCodeInheritUserConfig", "obsidianRestApiPolicy"];
export declare const SecurityScopeUnavailableError: typeof securitySettings.SecurityScopeUnavailableError;
export declare const resolveSecurityScope: typeof securitySettings.resolveSecurityScope;
export declare const readMachineSecuritySettings: typeof securitySettings.readMachineSecuritySettings;
export declare const setMachineSecuritySetting: typeof securitySettings.setMachineSecuritySetting;
export declare const dismissVaultSecuritySuggestion: typeof securitySettings.dismissVaultSecuritySuggestion;
export declare const isWeakening: typeof securitySettings.isWeakening;
export declare const effectiveSecuritySettings: typeof securitySettings.effectiveSecuritySettings;
export declare const securityInputsOf: typeof securitySettings.securityInputsOf;
export declare const EXECUTABLE_KEYS: readonly ["claudePath", "codexPath", "geminiCliPath", "antigravityPath"];
export declare const resolveCliPath: typeof securitySettings.resolveCliPath;
export declare const setMachineCliPath: typeof securitySettings.setMachineCliPath;
export declare const CliPathRejectedError: typeof securitySettings.CliPathRejectedError;
export declare const approvalsStoreVerdict: typeof mcpApprovals.approvalsStoreVerdict;
export { patchTargets };
export declare const codexTrustOnlyOverlay: typeof buildTrustOnlyOverlay;
export declare const ensureStoreGuardScript: typeof storeGuard.ensureStoreGuardScript;
export declare const snapshotSecurityStore: typeof securitySettings.snapshotSecurityStore;
export declare const checkSecurityStoreTamper: typeof securitySettings.checkSecurityStoreTamper;
export declare const onSecurityStoreTamper: typeof securitySettings.onSecurityStoreTamper;
export declare const DEFAULT_PROTECTED_PATHS: import("./types").ProtectedPath[];
export declare const DEFAULT_PROTECTED_COMMANDS: import("./types").ProtectedCommand[];
export declare const PROTECTED_CATEGORIES: {
    "modifies-gryphon": string;
    "modifies-editor": string;
    "runs-arbitrary-code": string;
    "escalates-privileges": string;
    "accesses-system": string;
    "persistent-execution": string;
    "destructive-operation": string;
    "network-exec": string;
    "network-fetch": string;
    "package-install": string;
    "user-custom": string;
};
export * from "./system-prompt-hints";
/** One audit-sink record (S3). */
interface DecisionAuditEntry {
    ts: number;
    tool: string;
    args_summary: string;
    decision: string;
    reason: string | null;
}
declare function createProtectionContext({ plugin, settings, config, hostAdapter, onDecision, security, }?: {
    plugin?: unknown;
    settings?: unknown;
    security?: unknown;
    config?: unknown;
    hostAdapter?: unknown;
    onDecision?: ((entry: DecisionAuditEntry) => unknown) | null;
}): {
    prepareSpawn({ kind, cwd, providerOptions }: {
        kind: string;
        cwd?: string;
        providerOptions?: Record<string, unknown>;
    }): {
        degradationReason: string;
        details: unknown;
        mode: string;
        ok: boolean;
        env: {};
        args: never[];
        cleanup: () => void;
        missing: never[];
    } | {
        ok: boolean;
        mode: string;
        env: Record<string, string>;
        args: string[];
        cleanup: () => void;
        degradationReason: string;
        details: unknown;
        missing: never[];
        settingsFile: string | null | undefined;
    } | {
        degradationReason: string;
        ok: boolean;
        env: {};
        args: never[];
        cleanup: () => void;
        details: {};
        missing: never[];
        mode?: undefined;
        settingsFile?: undefined;
    } | {
        degradationReason: string;
        details: {
            protectedModeOn: boolean;
        };
        mode: null;
        ok: boolean;
        env: {};
        args: never[];
        cleanup: () => void;
        missing: never[];
        settingsFile?: undefined;
    } | {
        degradationReason: string | null;
        details: Record<string, unknown> | {
            protectedModeOn: true;
            hasIpcServer: boolean;
            ipcServerListening: boolean;
            hasAbsolutePluginDir: boolean;
            hasNodeBinary: boolean;
        };
        mode: string;
        ok: boolean;
        env: {};
        args: never[];
        cleanup: () => void;
        missing: never[];
        settingsFile?: undefined;
    } | {
        ok: boolean;
        mode: string;
        env: Record<string, string>;
        args: string[];
        cleanup: () => void;
        degradationReason: null;
        details: Record<string, unknown> | {
            protectedModeOn: true;
            hasIpcServer: boolean;
            ipcServerListening: boolean;
            hasAbsolutePluginDir: boolean;
            hasNodeBinary: boolean;
        };
        missing: never[];
        settingsFile: string | null | undefined;
    };
    classify({ toolName, toolInput, vaultRoot, toolUseId }: {
        toolName: string;
        toolInput: Record<string, unknown> | null;
        vaultRoot?: string | null;
        toolUseId?: string;
    }): import("./types").ClassifyVerdict;
    isAvailable(): boolean | undefined;
    /**
     * Callable gate API — the primary entry for headless consumers (Peitho,
     * CLI hosts, tests). Classify the proposed tool call and return a
     * structured allow/deny decision without any UI interaction.
     *
     * @param {object} opts
     *   tool  — raw tool name (provider-specific; e.g. "bash", "read_file")
     *   args  — tool input object (same shape as tool_use.input)
     *   mode  — permission mode override ("default"|"acceptEdits"|"bypassPermissions"|"plan");
     *           falls back to the security snapshot's permissionMode, then "default"
     *   scope — { allowedRoots?: string[] } — vaultRoot is taken as scope.allowedRoots[0]
     *           for path classification
     *
     * @returns {Promise<{decision: "allow"|"deny", reason: string|null}>}
     *
     * Implementation notes:
     *   - classify() returns null for read-only tools (Read/Glob/Grep) and for
     *     tools whose protection toggle is off → fast-path to {decision:"allow"}.
     *   - For protected matches, checkPermission is called with a headless ctx
     *     (no plugin.app). Its no-modal fallback returns {allow:false} synchronously
     *     (the promise resolves in the next microtask with no I/O).
     *   - "prompt" decision is not surfaced today: in headless contexts,
     *     "would have prompted" collapses to "deny" (the no-plugin.app fallback
     *     in checkPermission fires before any modal path is reached). A future
     *     refactor can split these once the modal path is HostAdapter-injected.
     *     TODO(Phase-1-follow-up): surface {decision:"prompt"} when checkPermission
     *     can signal intent before falling back, without modifying permission-gate.
     */
    decide({ tool, args, mode, scope }: {
        tool: string;
        args: Record<string, unknown>;
        mode?: string;
        scope?: {
            allowedRoots?: string[];
        };
    }): Promise<{
        decision: string;
        reason: string | null;
    }>;
};
