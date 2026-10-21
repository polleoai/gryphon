/**
 * Gryphon constants.
 *
 * TOOL_STATUS_CORE covers the built-in tool names (shared by the SDK
 * tool loop and the local CLI adapter). Consuming plugins that add
 * MCP tools merge their own status map via the view's
 * options.extraToolStatus hook.
 */
declare const TOOL_STATUS_CORE: {
    Bash: string;
    Read: string;
    Write: string;
    Edit: string;
    Glob: string;
    Grep: string;
    WebSearch: string;
    WebFetch: string;
    Agent: string;
    TodoRead: string;
    TodoWrite: string;
    AskUser: string;
};
declare const DEFAULT_PROTECTED_PATHS: {
    pattern: string;
    category: string;
    userRisk: string;
    explanation: string;
}[];
declare const DEFAULT_PROTECTED_COMMANDS: ({
    pattern: string;
    category: string;
    userRisk: string;
    explanation: string;
    platforms?: undefined;
} | {
    pattern: string;
    platforms: string[];
    category: string;
    userRisk: string;
    explanation: string;
})[];
declare const DEFAULT_SETTINGS: {
    claudePath: string;
    permissionMode: string;
    model: string;
    effort: string;
    openInMainTab: boolean;
    lastSessionId: any;
    providerPreference: string;
    anthropicApiKey: string;
    openaiApiKey: string;
    googleApiKey: string;
    codexPath: string;
    geminiCliPath: string;
    antigravityPath: string;
    fallbackProviderPreference: string;
    fallbackModel: string;
    braveSearchApiKey: string;
    compactionSummary: any;
    maxReadFileSizeMb: number;
    protectedPathsEnabled: boolean;
    protectedCommandsEnabled: boolean;
    blockPackageInstall: boolean;
    protectedPathsDisabled: any[];
    protectedPathsCustom: any[];
    protectedCommandsDisabled: any[];
    protectedCommandsCustom: any[];
    protectedMode: boolean;
    autoDenyProtected: boolean;
    devCliDebug: boolean;
    claudeCodeInheritUserConfig: boolean;
    autoCompactSdk: boolean;
    autoRetryOnRateLimit: boolean;
    useExactTokenCounting: boolean;
    confirmOnContextOverflow: boolean;
    obsidianRestApiPolicy: string;
    restApiWarnThreshold: number;
    memoryArchiveAgeDays: number;
    connectionTimeoutMs: any;
};
declare const MODELS: {
    value: string;
    label: string;
    desc: string;
}[];
declare const MODEL_ALIAS_MIGRATION: Record<string, string>;
declare const MODEL_RETIREMENT_MIGRATION: Record<string, string>;
declare const EFFORTS: {
    value: string;
    label: string;
    desc: string;
}[];
declare const PERMS: {
    value: string;
    label: string;
    desc: string;
}[];
declare const MODEL_CONTEXT: Record<string, number>;
declare const COLD_START_BUDGET_MS: Record<string, number>;
declare const DEFAULT_COLD_START_BUDGET_MS = 60000;
declare const MIN_COLD_START_BUDGET_MS = 5000;
declare const MAX_COLD_START_BUDGET_MS = 600000;
/**
 * Resolve the connection-timeout budget for the current send.
 *
 * Pure function so it can be unit-tested without touching the chat-view
 * subsystem. Returns a finite positive number of milliseconds.
 *
 * @param {Object} args
 * @param {number|null|undefined} args.override   settings.connectionTimeoutMs
 * @param {string} args.model                     settings.model identifier
 * @returns {number}                              budget in ms
 */
declare function resolveConnectionTimeoutMs({ override, model }: {
    override?: unknown;
    model?: string;
}): number;
declare const CONTEXT_WARN_PCT = 80;
declare const CONTEXT_WARN_RESET_PCT = 75;
declare const AUTO_COMPACT_SDK_THRESHOLD_PCT = 95;
declare const SLASH_COMMANDS: ({
    cmd: string;
    desc: string;
    takesArgs: boolean;
} | {
    cmd: string;
    desc: string;
    takesArgs?: undefined;
})[];
declare const CC_BLOCKED_IN_STREAM_JSON: Set<string>;
declare const RESERVED_SKILL_NAMES: Set<string>;
declare const DEFAULT_PROVIDER_PREFERENCE = "auto";
declare const PROVIDER_PREFS: ({
    value: string;
    label: string;
    desc: string;
    deprecated?: undefined;
} | {
    value: string;
    label: string;
    desc: string;
    deprecated: boolean;
})[];
declare const FALLBACK_PROVIDER_PREFS: ({
    value: string;
    label: string;
    desc: string;
    deprecated?: undefined;
} | {
    value: string;
    label: string;
    desc: string;
    deprecated: boolean;
})[];
/**
 * The provider options to actually render, given what the user is on now.
 *
 * Deprecated providers are hidden — offering a dead end to someone choosing a
 * provider for the first time is worse than offering nothing. But a provider
 * the user has ALREADY selected always stays visible, however deprecated:
 * `SettingComponent.setValue()` on an id with no matching <option> leaves the
 * select displaying some other provider while `settings.providerPreference`
 * still says the old one. The user would then read the wrong provider off
 * their own settings screen.
 *
 * @param prefs    PROVIDER_PREFS or FALLBACK_PROVIDER_PREFS
 * @param current  the currently persisted preference
 */
declare function visibleProviderPrefs<T extends {
    value: string;
    deprecated?: boolean;
}>(prefs: T[], current: string | null | undefined): T[];
declare const PROTECTED_CATEGORIES: {
    "modifies-gryphon": string;
    "modifies-editor": string;
    "runs-arbitrary-code": string;
    "escalates-privileges": string;
    "accesses-system": string;
    "persistent-execution": string;
    "destructive-operation": string;
    "network-exec": string;
    "network-fetch": string;
    "user-custom": string;
};
export { TOOL_STATUS_CORE, DEFAULT_SETTINGS, DEFAULT_PROVIDER_PREFERENCE, DEFAULT_PROTECTED_PATHS, DEFAULT_PROTECTED_COMMANDS, PROTECTED_CATEGORIES, MODELS, MODEL_ALIAS_MIGRATION, MODEL_RETIREMENT_MIGRATION, EFFORTS, PERMS, MODEL_CONTEXT, SLASH_COMMANDS, CC_BLOCKED_IN_STREAM_JSON, RESERVED_SKILL_NAMES, PROVIDER_PREFS, FALLBACK_PROVIDER_PREFS, visibleProviderPrefs, CONTEXT_WARN_PCT, CONTEXT_WARN_RESET_PCT, AUTO_COMPACT_SDK_THRESHOLD_PCT, COLD_START_BUDGET_MS, DEFAULT_COLD_START_BUDGET_MS, MIN_COLD_START_BUDGET_MS, MAX_COLD_START_BUDGET_MS, resolveConnectionTimeoutMs, };
