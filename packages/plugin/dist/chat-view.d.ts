/**
 * GryphonChatView — core chat ItemView used by Gryphon standalone and by
 * consuming plugins that compose Gryphon's chat surface.
 *
 * Responsibilities:
 *   - Render the chat UI (toolbar, messages, status bar, input, autocomplete)
 *   - Stream responses from the active LLM provider (CLI or SDK)
 *   - Persist and restore chat history (merges local log + CLI .jsonl)
 *   - Handle plugin-level slash commands (see SLASH_COMMANDS in constants.js
 *     for the authoritative inventory) and forward everything else to the
 *     provider for its own slash-command processing
 *
 * Extension points (passed via constructor `options`):
 *   - extraToolStatus      — entries merged into the tool→status map for
 *                            custom MCP tools
 *   - extraProcessArgs     — CLI args appended to every CLI provider spawn.
 *                            Cross-provider flags are filtered (issue #39):
 *                            a Claude-only flag like --disable-slash-commands
 *                            is silently dropped before the codex-cli or
 *                            gemini-cli spawn so the spawn doesn't fail with
 *                            "unknown argument."
 *   - extraProcessArgsByProvider — { 'claude-code': [...], 'codex-cli': [...],
 *                            'gemini-cli': [...], ... } — per-provider
 *                            extra CLI args. Skips the cross-provider
 *                            filter (entries are already targeted). Use
 *                            this for clean per-provider routing instead
 *                            of relying on the filter.
 *   - claudeCodeScope      — { inheritUserConfig, settingSources, mcpServers,
 *                            includeProjectMcp, autoMemory, pluginDirs,
 *                            memoryFiles } — which Claude Code config a
 *                            claude-code chat launches with (issues #25,
 *                            #27; default: no settings files from the vault
 *                            or the user, approved vault MCP servers only).
 *                            When supplied — ANY field — it REPLACES the
 *                            user's Settings → Advanced toggle (the toggle
 *                            isn't merged in). Each field the consumer
 *                            leaves unset takes the provider default on its
 *                            own: `{ memoryFiles: [...] }` behaves exactly
 *                            like no scope on every other field.
 *                            `pluginDirs` (→ --plugin-dir) must be trusted
 *                            dirs from the consumer's own install;
 *                            `memoryFiles` (→ one
 *                            --append-system-prompt-file, @-imports
 *                            expanded) carries the vault CLAUDE.md, which
 *                            the default no longer loads. Object-form `mcpServers` are
 *                            executed WITHOUT approval: build them from your
 *                            plugin's own code, never from files inside the
 *                            vault. Vault `.mcp.json` servers run only once
 *                            the user approves them. Ignored by every
 *                            provider except claude-code. See provider-runtime
 *                            providers/claude-code/scope.ts.
 *   - onBeforeSend         — callback(text) => boolean. Return true to
 *                            "consume" a message (intercept domain-specific
 *                            commands before they reach the provider).
 *   - autocompleteSources  — array of { name, matches(text), suggest(text) }.
 *                            Core prepends a built-in slash source; consumer
 *                            sources extend it.
 *   - stopStreamingHooks   — array of hook(view) callbacks run BEFORE core
 *                            teardown in stopStreaming (for cleaning up
 *                            plugin-owned side processes).
 *   - viewType / displayText / icon — per-plugin view identity.
 *   - securityOverrides    — issue #29. Capability constraints from the
 *                            consumer's own code, keyed by the closed set
 *                            of weakening keys (protectedMode,
 *                            permissionMode, …). They win over this
 *                            machine's confirmed values. Weakening values in
 *                            the host's settings object are SUGGESTIONS, not
 *                            inputs: until the user confirms them on this
 *                            machine (toolbar, Settings, the one-time
 *                            prompt), protections stay on.
 *   - securityHostId       — issue #29; REQUIRED since #30. The store
 *                            namespace for this host's confirmed security
 *                            values and CLI paths. There is no manifest.id
 *                            fallback (the manifest is vault-resident):
 *                            without it, protections stay on and security
 *                            writes raise a visible error. Pass the id your
 *                            plugin used before to keep its stored values.
 *   - securityOverrides.paths — issue #30. CLI binaries pinned in code
 *                            ({ claudePath, codexPath, geminiCliPath,
 *                            antigravityPath }); they win over this
 *                            machine's confirmed paths and detection.
 *
 * This file knows nothing about any specific consuming plugin's domain.
 * All coupling comes through the options bag; consumers wire their own
 * behavior via autocompleteSources, stopStreamingHooks, onBeforeSend.
 */
import { ItemView, Menu } from "obsidian";
import type { App, Component, TFile, WorkspaceLeaf } from "obsidian";
import type { LLMProvider, Result as ProviderResult } from "@polleoai/gryphon-provider-runtime";
import { collectContextSources, summarizeContext } from "./context-budget";
import * as securityUi from "./security-settings";
import { securitySettings } from "@polleoai/gryphon-protect";
import type { SecurityScope, EffectiveSecurity, StoreSnapshot } from "@polleoai/gryphon-protect";
import type { SkillRegistry } from "./skills";
import { ObsidianHostAdapter } from "./obsidian-host-adapter";
/** What `detectAvailable()` reports (provider-runtime factory.ts). */
interface DetectedProviders {
    cliPath: string | null;
    apiKey: string;
    apiKeySource: string | null;
    openaiKey: string;
    openaiKeySource: string | null;
    googleKey: string;
    googleKeySource: string | null;
    codexPath: string | null;
    geminiCliPath: string | null;
    antigravityPath: string | null;
}
/**
 * Options bag passed to the GryphonChatView constructor by consuming plugins.
 * All fields are optional; core sets safe defaults when they are absent.
 */
interface GryphonChatViewOptions {
    /** Entries merged into the tool→status map for custom MCP tools. */
    extraToolStatus?: Record<string, string>;
    /** CLI args appended to every CLI provider spawn (cross-provider filtered). */
    extraProcessArgs?: string[];
    /** Per-provider extra CLI args, keyed by provider kind. */
    extraProcessArgsByProvider?: Record<string, string[]>;
    /** Claude Code launch scope (issues #25, #27). Overrides the Advanced-tab toggle when set; unset fields take the provider default. */
    claudeCodeScope?: {
        inheritUserConfig?: boolean;
        settingSources?: Array<"user" | "project" | "local">;
        mcpServers?: "project" | "inherit" | Record<string, unknown>;
        includeProjectMcp?: boolean;
        autoMemory?: boolean;
        /** Absolute, consumer-owned plugin dirs (skills/agents/commands) → --plugin-dir. Never vault paths. */
        pluginDirs?: string[];
        /** Absolute memory files (e.g. the vault CLAUDE.md) → one --append-system-prompt-file. */
        memoryFiles?: string[];
    };
    /** Callback invoked before each send. Return true to consume the message. */
    onBeforeSend?: ((text: string) => boolean) | null;
    /** Autocomplete sources extending the core slash-command source. */
    autocompleteSources?: AutocompleteSource[];
    /** Hook callbacks run before core streaming teardown. */
    stopStreamingHooks?: Array<(view: GryphonChatView) => void>;
    /** Obsidian WorkspaceLeaf view type identifier. */
    viewType?: string;
    /** Human-readable display text for the view tab. */
    displayText?: string;
    /** Icon ID used for the view tab. */
    icon?: string;
    /** Issue #29: weakening-key values set by the consumer's code (win over the machine store). #30: `paths` pins CLI binaries. */
    securityOverrides?: Partial<Record<string, unknown>> & {
        paths?: Partial<Record<string, string>>;
    };
    /** Issue #29/#30: REQUIRED — the store namespace for this host (no manifest.id fallback). */
    securityHostId?: string;
}
/** One persisted chat message (chat-history.json entry / in-memory transcript row). */
interface ChatMessage {
    role: string;
    text: string;
    ts?: string;
    source?: string;
    sessionId?: string | null;
    failed?: boolean;
    sideNote?: boolean;
    thinking?: string[];
}
/** A `{ value, label }` dropdown entry (MODELS / EFFORTS / PERMS / per-provider model lists). */
interface OptionItem {
    value: string;
    label: string;
    desc?: string;
}
/** A slash-command autocomplete entry (built-in SLASH_COMMANDS or a skill). */
interface SlashCommandEntry {
    cmd: string;
    desc: string;
    takesArgs?: boolean;
    isSkill?: boolean;
}
/** An autocomplete source: built-in slash source or a consumer-supplied one. */
interface AutocompleteSource {
    name: string;
    matches: (text: string) => boolean;
    suggest: (text: string) => SlashCommandEntry[];
}
/**
 * The plugin settings fields chat-view reads or writes. The host plugin's
 * settings object carries more keys; those are reached through the index
 * signature.
 */
interface ChatSettings {
    model?: string;
    effort?: string;
    permissionMode?: string;
    providerPreference?: string;
    lastSessionId?: string | null;
    compactionSummary?: string | null;
    memoryArchiveAgeDays?: number;
    autoCompactSdk?: boolean;
    useExactTokenCounting?: boolean;
    connectionTimeoutMs?: number | null;
    confirmOnContextOverflow?: boolean;
    autoRetryOnRateLimit?: boolean;
    anthropicApiKey?: string;
    [key: string]: unknown;
}
/**
 * The members of the host plugin instance that chat-view uses (see the
 * host-plugin contract in the GryphonChatView constructor). plugin.ts stays
 * CommonJS, so the shape is declared here rather than imported.
 */
interface GryphonPluginLike extends Component {
    app?: App;
    manifest?: {
        id: string;
        version: string;
    };
    settings: ChatSettings;
    saveSettings(): Promise<void>;
    ensureIpcListening?(timeoutMs: number): Promise<boolean>;
    _resetActiveSessions?(): void;
    _announceProviderChange?(fromPref: string, toPref: string): void;
    _resetRestApiCounter?(): void;
    _vaultRoot?(): string | null;
    getProjectionCalibrationDelta?(): number;
    recordProjectionCalibrationSample?(delta: number): void;
    skillRegistry?: SkillRegistry;
    hostAdapter?: unknown;
    mcpApprovalsGeneration?: number;
}
/**
 * The provider instance chat-view drives: the runtime's LLMProvider contract
 * plus the optional members some providers expose.
 */
type ChatProvider = Omit<LLMProvider, "contextTokens"> & {
    /** Written by chat-view to peg the meter after an overflow rejection. */
    contextTokens: number;
    kind?: string;
    costIsEstimate?: boolean;
    history?: Array<{
        role?: string;
    }>;
    countTokensForNext?: (userInput: string) => Promise<number | null>;
    onSessionExpired?: () => void;
};
/** Spawn-time identity of the live provider (see _computeProviderSignature). */
interface ProviderSpawnSignature {
    kind: string | null;
    model: string | null;
    effort: string | null;
    permissionMode: string | null;
    security?: string;
    scope: string;
    mcpApprovals: number;
}
/** A prompt submitted while a turn was streaming (issue #3). */
interface QueuedPrompt {
    text: string;
    bubbleEl: HTMLElement;
}
/** The most recent non-empty selection captured anywhere in the document. */
interface CachedSelection {
    text: string;
    file: TFile | null;
    capturedAt: number;
}
type ContextProjection = ReturnType<typeof summarizeContext> & {
    mode?: string;
};
type ContextSources = Awaited<ReturnType<typeof collectContextSources>>;
/** Transparency fields of a failover decision (issue #15). */
interface FailoverFields {
    requestedProvider: string;
    servedBy: string | null;
    fellBack: boolean;
    reason: string | null;
}
interface FailoverDecision extends FailoverFields {
    outcome: "served" | "unavailable";
    result: ProviderResult | null;
}
/** One construct+wire+send attempt supplied by sendMessage to _runFailover. */
interface FailoverAttemptOutcome {
    ok: boolean;
    provider: ChatProvider | null;
    result?: ProviderResult;
    error?: unknown;
}
type FailoverAttempt = (kind: string, modelOverride: string | undefined) => Promise<FailoverAttemptOutcome>;
/** `{ settings }` or a plugin instance — what the toolbar label helpers accept. */
type SettingsOrPlugin = (ChatSettings & {
    settings?: undefined;
}) | {
    settings: ChatSettings;
};
/**
 * Collapse consecutive identical paragraphs in streamed assistant
 * text. Sometimes a model (notably Gemini-2.5 via the CLI on macOS)
 * emits the same paragraph twice in a row before a tool call —
 * either via the SDK delivering both a delta and a non-delta event
 * with the same content, or via the model genuinely regenerating
 * its first paragraph. The result in chat is two indistinguishable
 * paragraphs back-to-back. This dedupes them at the rendering
 * boundary so it can't leak to the bubble regardless of which
 * provider produces it.
 *
 * Conservative: only collapses paragraphs that are byte-for-byte
 * identical AND non-trivial (≥40 chars, so common short headings
 * or list items aren't merged accidentally). Multi-paragraph
 * sequences with different content pass through unchanged.
 */
declare function _dedupeConsecutiveParagraphs(text: string): string;
declare function _collapseSummaryDrafts(text: string): string;
declare function _separateCanonicalBlocks(text: string): string;
declare function _isRateLimitError(err: unknown): boolean;
/**
 * Issue #34 deferred: extract the retry-after delay (in seconds) from a
 * rate-limit error so the auto-retry path can schedule a precise
 * resubmit instead of guessing. Returns null when no delay is parseable
 * — the caller should NOT auto-retry without a value (avoids tight
 * loops against unknown-cooldown rate limits).
 *
 * Recognized shapes:
 *   - `Retry-After` header (seconds OR HTTP-date) on err.headers / err.response.headers
 *   - "Please retry in 12.3s" / "retry in 500ms" copy in the error body
 *   - SDK-specific `retryAfterSeconds` / `retry_after` fields
 *
 * Capped at 60s — a per-day Gemini quota reports values like 86400s,
 * and queueing a 24h auto-retry is a footgun (background tab, cost,
 * staleness). Anything longer than 60 returns null so the user
 * deliberately decides whether to re-press Send later.
 */
declare function _parseRetryAfterSeconds(err: unknown): number | null;
declare function _replaceNoResponsePlaceholder(text: string): string;
declare function _providerLabelFor(preference: string): string;
declare function filterMessagesForSave(messages: ChatMessage[] | null | undefined, currentSessionId: string | null | undefined): ChatMessage[];
/**
 * Pure-function context-window pct for unit testing. Mirrors the
 * arithmetic in `_currentContextPct` so the boundary math (0, 80, 95,
 * 100) can be asserted without a DOM.
 *
 * @param {number} tokens
 * @param {number} windowSize
 * @returns {number} integer 0..100
 */
declare function computeContextPct(tokens: number, windowSize: number): number;
/**
 * Pure-function decision: should we start an SDK auto-compact?
 *
 * @param {object} state
 *   pct           — current context %
 *   isSdk         — provider is SDK?
 *   autoCompactSdk — user setting (true = enabled)
 *   isCompacting  — already a compact in flight?
 *   messageCount  — messages.length (need >= 4 to summarize)
 *   lagFailsafe   — bypass pct threshold (catch-branch path)
 * @returns {boolean}
 */
declare function shouldStartAutoCompact({ pct, isSdk, autoCompactSdk, isCompacting, messageCount, lagFailsafe, }: {
    pct?: number | null;
    isSdk?: boolean;
    autoCompactSdk?: boolean;
    isCompacting?: boolean;
    messageCount?: number;
    lagFailsafe?: boolean;
}): boolean;
/**
 * Pure-function hysteresis decision for the 80% one-shot warning.
 * Encodes: fire once when crossing CONTEXT_WARN_PCT (and below
 * AUTO_COMPACT_SDK_THRESHOLD_PCT); reset only when dropping below
 * CONTEXT_WARN_RESET_PCT.
 *
 * @param {{shown: boolean}} prev
 * @param {number} pct
 * @returns {{shown: boolean, fire: boolean}}
 *   shown — new value of the "warning shown" flag
 *   fire  — whether to flash this turn
 */
declare function nextContextWarningState(prev: {
    shown?: boolean;
} | null | undefined, pct: number): {
    shown: boolean;
    fire: boolean;
};
declare function modelButtonText(settingsOrPlugin: SettingsOrPlugin): string;
/**
 * The model list a given provider kind can actually serve, as
 * `[{value, label}]`.
 *
 * Single source for BOTH the toolbar menu and the `/model <id>` slash
 * command. They diverged once: the menu was made provider-aware while
 * `/model` kept validating against the Anthropic `MODELS` list, so a valid
 * Gemini or GPT id typed as `/model <id>` was rejected for every non-Claude
 * provider. Keep both callers on this function.
 */
declare function _modelOptionsForKind(kind: string | null | undefined): OptionItem[];
declare function modelButtonTitle(settingsOrPlugin: SettingsOrPlugin): string;
declare class GryphonChatView extends ItemView {
    plugin: GryphonPluginLike;
    messages: ChatMessage[];
    isStreaming: boolean;
    streamingText: string;
    streamingEl: HTMLElement | null;
    streamingBubble: HTMLElement | null;
    claudeProcess: ChatProvider | null;
    _providerSpawnSignature: ProviderSpawnSignature | null;
    cumulativeCost: number;
    _priorTurnHadProtectedDeny: boolean;
    _refusalInCurrentTurn: boolean;
    _lastRefusalText: string;
    _lastRefusalTs: number;
    _queuedPrompts: QueuedPrompt[];
    _pendingQueuedTexts: string[];
    toolStatusMap: Record<string, string>;
    extraProcessArgs: string[];
    extraProcessArgsByProvider: Record<string, string[]>;
    claudeCodeScope: GryphonChatViewOptions["claudeCodeScope"] | null;
    onBeforeSend: ((text: string) => boolean) | null;
    viewType: string;
    viewDisplayText: string;
    viewIcon: string;
    autocompleteSources: AutocompleteSource[];
    stopStreamingHooks: Array<(view: GryphonChatView) => void>;
    inputEl: HTMLTextAreaElement;
    messagesEl: HTMLElement;
    toolbarStatus: HTMLElement;
    sendBtn: HTMLElement;
    stopBtn: HTMLElement;
    modelBtn: HTMLElement;
    effortBtn: HTMLElement;
    permBtn: HTMLElement;
    contextBtn: HTMLElement;
    projectionBtn: HTMLElement;
    restApiBtn: HTMLElement;
    autocompleteEl: HTMLElement | null;
    _welcomePanelEl: HTMLElement | null;
    _loadMoreHint: HTMLElement | null;
    autocompleteIdx: number;
    _userInitiatedAbort: boolean;
    _sendErroredThisTurn: boolean;
    _contextWarningShown: boolean;
    _projectionWarningShown: boolean;
    _calibrationMissingWarned: boolean;
    _compactionInProgress: boolean;
    _compactionPending: boolean;
    _compactSummaryPending: boolean;
    _autoCompactInProgress: boolean;
    _autoRetryFired: boolean;
    _pendingLoadWarning: string | null;
    _autoCompactRetryText: string;
    _statusBeforeAutocomplete: string;
    _preHistoryInput: string;
    _promptHistoryIdx: number;
    _historyLoadedUpTo: number;
    _lastCalibratedTokens: number;
    _lastMeasuredTokens: number;
    _calibrationDelta: number;
    _fullHistory: ChatMessage[];
    _cachedPromptHistory: string[] | null;
    _cachedSelection: CachedSelection | null;
    _saveQueue: Promise<boolean | void> | null;
    _chatHistorySaveError: string | null;
    _lastSeedStats: {
        kept?: number;
        dropped: number;
        cap?: number;
    } | null;
    _pendingSdkHistory: Array<{
        role: string;
        content: string;
    }> | null;
    _projectionLastResult: ContextProjection | null;
    _projectionSources: ContextSources | null;
    _triggerKwCache: Set<string> | null;
    _triggerKwSnapshot: string | null;
    _connTimeout: number | null;
    _stallTimeout: number | null;
    _autoRetryTimeout: number | null;
    _projectionDebounceTimer: number | null;
    securityOverrides: Record<string, unknown>;
    _fallbackHostAdapter: ObsidianHostAdapter | null;
    _turnProviderKind: string | null;
    securityPathOverrides: Record<string, string>;
    securityHostId: string | undefined;
    constructor(leaf: WorkspaceLeaf, plugin: GryphonPluginLike, options?: GryphonChatViewOptions);
    getViewType(): string;
    getDisplayText(): string;
    getIcon(): string;
    onOpen(): Promise<void>;
    /**
     * Issue #29: one audit line per spawn when the consumer's code sets
     * security values, so a forced-off protection is visible in the log.
     */
    _logSecurityAudit(security: EffectiveSecurity): void;
    /**
     * Issue #29: the security half of a provider's construction options. The
     * CLI flag and every in-process gate come from the same frozen snapshot.
     */
    _securitySpawnOptions(security: EffectiveSecurity): {
        permissionMode: string;
        security: Readonly<securitySettings.SecurityValueTypes & {
            autoDenyProtected: boolean;
            protectedPathsCustom: string[];
            protectedCommandsCustom: string[];
            source: Partial<Record<securitySettings.WeakeningKey, "default" | "override" | "machine">>;
            unconfirmed: securitySettings.WeakeningKey[];
            scopeAvailable: boolean;
            paths: Partial<Record<securitySettings.ExecutableKey, string>>;
            unconfirmedPaths: securitySettings.ExecutableKey[];
        }>;
    };
    /** Issue #29: react to a `gryphon:security-settings-changed` event. */
    _onSecuritySettingsChanged(scope: SecurityScope | null): void;
    /**
     * Issue #29: this host's security-store scope (vault + host plugin), or
     * null when it can't be derived (reads then fail closed).
     */
    _securityScope(): securitySettings.SecurityScope;
    /**
     * Issue #29: the frozen effective security snapshot — the consumer's
     * overrides, then this machine's confirmed values, then the protected
     * defaults. Every badge, menu, diagnostics line and provider spawn reads
     * this; the host's settings object only supplies suggestions.
     */
    _effectiveSecurity(): Readonly<securitySettings.SecurityValueTypes & {
        autoDenyProtected: boolean;
        protectedPathsCustom: string[];
        protectedCommandsCustom: string[];
        source: Partial<Record<securitySettings.WeakeningKey, "default" | "override" | "machine">>;
        unconfirmed: securitySettings.WeakeningKey[];
        scopeAvailable: boolean;
        paths: Partial<Record<securitySettings.ExecutableKey, string>>;
        unconfirmedPaths: securitySettings.ExecutableKey[];
    }>;
    /** Issue #30: the consumer's overrides plus its code-set CLI paths. */
    _overridesWithPaths(): {
        paths: Record<string, string>;
    };
    /**
     * Issue #30: the factory-facing scope for CLI path resolution — this
     * view's host id and code-set path overrides. The factory resolves each
     * kind it needs through `resolveCliPath` with exactly these.
     */
    /**
     * R43-7: the host adapter for spawns. Gryphon's own plugin supplies one;
     * an embedding plugin that doesn't gets an Obsidian Notice adapter here,
     * so "protection degraded" notices reach the user, not just the console.
     */
    _spawnHostAdapter(): unknown;
    _cliPathScope(): {
        securityHostId: string;
        securityOverrides: {
            paths: Record<string, string>;
        };
    };
    /**
     * Issue #30: every CLI kind's binary, resolved for THIS view (its host id
     * and overrides; never the host's data.json). A stored path that no longer
     * validates falls back to detection and is reported once.
     */
    _resolveCliPaths(): Record<string, string>;
    /** Issue #30: the scope plus the resolved map — what a spawn is built from. */
    _cliPathOptions(): {
        cliPaths: Record<string, string>;
        securityHostId: string;
        securityOverrides: {
            paths: Record<string, string>;
        };
    };
    /**
     * Issue #30 (G2): the turn-window tamper check. With Protected Mode off
     * and no hook (or a CLI that ignores hooks), an agent could rewrite
     * Gryphon's security settings mid-reply. At turn end, any change that
     * wasn't Gryphon's own and that WEAKENS a setting is undone, and the user
     * is told which provider's turn it happened in. Never throws.
     */
    _beginTurnTamperWindow(): securitySettings.StoreSnapshot;
    _endTurnTamperWindow(before: StoreSnapshot | null, kind: string): void;
    /**
     * Issue #29 public API: set a weakening key from a user gesture on this
     * machine — for an embedder's own settings UI. Same path the toolbar
     * uses: store write, mirror into the host's settings, workspace event,
     * live-process teardown, badge refresh. Returns false (after a Notice)
     * when the write can't be saved.
     */
    applySecuritySetting(key: string, value: unknown): Promise<boolean>;
    /**
     * Issue #29: open the one-time confirm prompt for this host's scope when
     * the vault's settings file holds weakening values not confirmed on this
     * machine. Once per scope per app session; `force` reopens it (badge).
     */
    _maybePromptVaultSecurity(force?: boolean): securityUi.ConfirmVaultSecurityModal;
    /**
     * Compute the spawn-time identity that the next createProvider would use,
     * from the current plugin settings. Resolved provider kind goes through
     * getActiveProviderKind so "auto" + only-an-OpenAI-key compares as the
     * concrete kind createProvider would pick (not the literal "auto").
     *
     * Shape mirrors the four spawn-time settings: provider kind, model,
     * effort, permissionMode. Values are the RAW settings values (not the
     * provider's coerced/resolved forms) so the stamp captured at spawn and
     * the value computed later compare like-for-like.
     *
     * @returns {{kind: string, model: any, effort: any, permissionMode: any}}
     */
    _computeProviderSignature(): {
        kind: string;
        model: string;
        effort: string;
        permissionMode: string;
        security: string;
        scope: string;
        mcpApprovals: number;
    };
    /**
     * Issue #25: the Claude Code launch scope for the next spawn. A consumer's
     * `claudeCodeScope` option replaces the Advanced-tab toggle (embedders own
     * their chat's config surface); otherwise the toggle decides. That is NOT
     * all-or-nothing within the scope: the provider defaults each field the
     * consumer leaves unset on its own, so `{ memoryFiles: [...] }` behaves
     * exactly like `undefined` on every other field (issue #27). Undefined ⇒
     * the provider default (no settings files; approved vault MCP only).
     */
    _resolveClaudeCodeScope(): {
        inheritUserConfig?: boolean;
        settingSources?: Array<"user" | "project" | "local">;
        mcpServers?: "project" | "inherit" | Record<string, unknown>;
        includeProjectMcp?: boolean;
        autoMemory?: boolean;
        /** Absolute, consumer-owned plugin dirs (skills/agents/commands) → --plugin-dir. Never vault paths. */
        pluginDirs?: string[];
        /** Absolute memory files (e.g. the vault CLAUDE.md) → one --append-system-prompt-file. */
        memoryFiles?: string[];
    };
    /**
     * True when a live process exists, was stamped with a spawn signature,
     * and that signature no longer matches current settings. Defensive: an
     * unstamped process (no signature recorded) reports NO change so we never
     * tear down a process we can't reason about.
     *
     * @returns {boolean}
     */
    _providerSignatureChanged(): boolean;
    /**
     * The teardown half of the embedding-consumer contract. When a live
     * subprocess's spawn-time identity no longer matches settings (the user
     * switched provider/model/effort/permission through a consumer's own
     * settings tab and fired gryphon:settings-changed), abort it and null it
     * so the next message spawns a fresh process for the new provider. Surface
     * the same "takes effect on next message" notice that the imperative
     * _resetActiveSessions() path shows for Gryphon-as-a-plugin.
     *
     * No-op when there's no live process or the signature is unchanged — an
     * unrelated settings change (e.g. a UI toggle) must not kill an active
     * session. A process that has already died is left in place for the send
     * path to replace; we only abort processes that are still alive.
     */
    _teardownLiveProcessIfSettingsChanged(): void;
    /**
     * Mirror the textarea's layout in a hidden div with a span marker at
     * the caret position, measure the marker's pixel offset, and return
     * the geometry needed by both `_scrollCaretIntoView` (issue #2) and
     * the visual-line-aware ArrowUp/Down boundary checks (issue #10).
     *
     * Returns null if the textarea is empty or unavailable. The mirror
     * element is created and removed within this call — no shared DOM
     * state outlives the measurement.
     *
     * @returns {{caretTop: number, totalHeight: number, lineHeight: number, clientHeight: number} | null}
     */
    _measureCaretGeometry(): {
        caretTop: number;
        totalHeight: number;
        lineHeight: number;
        clientHeight: number;
    };
    /**
     * Scroll `inputEl` so the current caret is visible. The textarea wraps
     * soft lines, so a newline-count heuristic underestimates the visual
     * line of the caret; we mirror the textarea's layout in a hidden div
     * and measure the caret's pixel offset directly.
     */
    _scrollCaretIntoView(): void;
    /**
     * Walk prompt history one step in the given direction. Called from
     * the post-frame ArrowUp/Down check (issue #14) only after we've
     * confirmed the native textarea couldn't move the caret (i.e., the
     * caret was on the boundary visual row).
     *
     * @param {"back"|"forward"} direction
     * @param {string} currentText  — the textarea value at keydown time;
     *                                used as the "pre-history input" snapshot
     *                                that `forward` can restore once the
     *                                walk passes the newest entry.
     */
    _walkPromptHistory(direction: "back" | "forward", currentText: string): void;
    onClose(): Promise<void>;
    _showMenuAbove(menu: Menu, target: EventTarget): void;
    showModelMenu(e: {
        target: EventTarget | null;
    }): void;
    /**
     * Re-compute toolbar button labels in place. Called by:
     *   1. The plugin's _resetActiveSessions() \u2014 direct invocation when
     *      settings change that affect what the toolbar should display
     *      (most notably providerPreference \u2014 Bug #21).
     *   2. The `gryphon:settings-changed` workspace event (issue #40) \u2014
     *      fires from plugin.saveSettings() so consumer-plugin settings
     *      tabs that mutate plugin.settings + saveSettings() also trigger
     *      a badge refresh, not just Gryphon's own settings tab.
     *
     * Refreshes ALL toolbar buttons that are derived from plugin.settings
     * (model, effort, permission). The context-meter badge is updated
     * separately by the streaming layer.
     */
    refreshToolbarLabels(): void;
    /**
     * Issue #29: the permission badge shows the EFFECTIVE mode. "⚠" marks
     * either unconfirmed vault values (click to review) or a host with no
     * security scope (protections forced on).
     */
    _refreshPermBadge(): void;
    /**
     * Issue #29: the permission menu's entries. The checkmark follows the
     * effective mode; when the consumer's `securityOverrides` sets the mode,
     * every entry is disabled with "Set by <host>" so a pick can't look like
     * it did something.
     */
    _permMenuEntries(): {
        value: string;
        title: string;
        disabled: boolean;
        tooltip: string;
    }[];
    showEffortMenu(e: {
        target: EventTarget | null;
    }): void;
    showPermMenu(e: {
        target: EventTarget | null;
    }): void;
    changeSetting(key: string, value: string, btnEl: HTMLElement, list: OptionItem[]): Promise<void>;
    /**
     * Apply a /model or /effort inline-set command. Validates the value,
     * persists, updates the toolbar button, and — if a process is alive —
     * aborts it so the next message spawns with the new flag. Extracted
     * from the /model and /effort handlers so both share validation and
     * status messaging.
     */
    _applyDirectSetting(settingKey: string, newValue: string, list: OptionItem[], btnEl: HTMLElement | null, displayLabel: string): Promise<void>;
    _refreshModelTooltip(): void;
    /**
     * F1 Stage D (v2.0) — return the calibration delta to plug into the
     * estimator. Read fresh from the plugin on every projection so split
     * panes (multiple GryphonChatView instances) don't drift: when
     * instance A's turn completes and updates the plugin-level buffer,
     * instance B picks up the new delta on its next refresh instead of
     * staying on a stale view-cached value.
     *
     * The typeof guard tolerates a vendored Gryphon older than this
     * chat-view; see CLAUDE.md's standing model on submodule consumers.
     */
    _currentCalibrationDelta(): number;
    /**
     * F4 (v1.7.0) — sync the REST API toolbar chip with the current
     * `obsidianRestApiPolicy` setting. Called on create, after the user
     * clicks the chip, and from the `gryphon:settings-changed` listener
     * so a settings-tab change keeps the chip honest without a reload.
     */
    _updateRestApiChip(): void;
    updateContextMeter(contextTokens: number): void;
    /**
     * v1.7.0 \u2014 re-render the "Used N%" chip against the CURRENT model's
     * window, using the persisted `_lastMeasuredTokens` (not the live
     * `claudeProcess.contextTokens` which gets reset to 0 when a model
     * switch tears down the provider instance).
     *
     * Without this, switching Haiku (200K) \u2192 Sonnet (1M) after a turn
     * left the chip frozen at the pre-switch percentage. The user sees
     * "Used 29%" on Sonnet even though 58K / 1M is actually 6%, and the
     * number contradicts both the new denominator and the projection
     * chip's reading.
     *
     * Called from the settings-changed event handler.
     */
    _refreshMeasuredAgainstCurrentModel(): void;
    /**
     * Schedule a projection refresh PROJECTION_DEBOUNCE_MS in the future,
     * collapsing back-to-back calls. Called on every keystroke.
     */
    _refreshContextProjectionDebounced(): void;
    /**
     * Compute the projection and render the chip. Async because SDK mode
     * may call Anthropic's free `countTokens` endpoint for an authoritative
     * count (when the user hasn't disabled `useExactTokenCounting`).
     *
     * On any error path the chip falls back to "\u2014" and the heuristic
     * estimator; the user never sees an exception.
     */
    _refreshContextProjection(): Promise<void>;
    /**
     * Re-stat the filesystem inputs (CLAUDE.md hierarchy + memory dir).
     * Cheap (<5ms typically), but we don't run it per keystroke \u2014 only on
     * session boundaries (/new, /clear, model change, plugin load).
     */
    _reloadContextSources(): Promise<void>;
    /**
     * Pure DOM update for the projection chip. Visual states match the
     * existing context meter so the two read consistently:
     *   <80%        \u2014 normal
     *   80-94%      \u2014 gryphon-context-warn (yellow)
     *   \u226595%        \u2014 gryphon-context-danger (red)
     * Plus a mode indicator: "~" prefix on projected; clean number on
     * exact (SDK countTokens path).
     */
    _updateProjectionChip(result: ContextProjection | null): void;
    /**
     * One-shot status flash the first time projection crosses
     * CONTEXT_WARN_PCT in this view's lifetime. Reset on session boundary
     * so the warning re-fires for a fresh /clear'd session that climbs
     * back up.
     */
    _maybeFlashProjectionWarning(result: ContextProjection | null): void;
    /**
     * Whether the active provider is the Anthropic SDK (stateless \u2014 Gryphon
     * owns the history) rather than Claude Code (stateful \u2014 CC owns the
     * history). Drives auto-compact decisions: SDK mode requires Gryphon
     * to compact; CC mode delegates to Claude Code's own auto-compact.
     *
     * Source of truth is the live provider's sessionId tag (synthetic
     * `sdk-...` for SDK, real UUID for CC). Falls back to settings
     * preference when no provider is active yet.
     */
    _isSdkMode(): boolean;
    /**
     * Current context-window utilization as a 0-100 integer percentage,
     * derived from the live provider's contextTokens count divided by the
     * model's window. Returns 0 when no provider has reported usage yet.
     */
    _currentContextPct(): number;
    handleChatCommand(text: string): Promise<boolean>;
    /**
     * Shows a confirmation modal before /clear. Resolves to true if the
     * user clicked Clear, false if they cancelled or dismissed.
     */
    /**
     * F1 (v1.7.0) confirm modal for context-overflow send. Shown when the
     * projection chip reads ≥95% of the window. Wording is structured
     * around the recovery levers so the user can pick one before sending
     * a doomed prompt.
     */
    _confirmOverflowSend(projection: ContextProjection): Promise<unknown>;
    /**
     * F2 (v1.7.0) — show a per-source breakdown of where context tokens
     * are going. Opens on click of the "Used X%" or "Next ~X%" chips.
     * Renders one row per source (system prompt, tool schemas, each
     * loaded CLAUDE.md, memory dir, chat history, current input) with a
     * proportional bar and an absolute K-token count, plus a few action
     * buttons that target the largest movable sources.
     *
     * Reads the live projection result if one exists; otherwise computes
     * a fresh snapshot so the modal still renders something useful on
     * first open before any keystroke has triggered a debounce.
     */
    _showContextBreakdownModal(): Promise<void>;
    _confirmClear(): Promise<unknown>;
    _cmdClearSession(): Promise<void>;
    /**
     * /context — show current context-window usage as a structured
     * system message. Includes used + remaining + headroom to the next
     * two threshold transitions (80% warning, 95% auto-compact for SDK
     * mode), plus a phase-appropriate options list. More informative
     * than the older one-line status flash.
     */
    _cmdShowContext(): void;
    /**
     * /usage — show combined session stats: message count, cumulative
     * cost, current context usage. More complete than /cost, which shows
     * only the dollar number.
     */
    _cmdShowUsage(): void;
    /**
     * /compact — replace the message history with an LLM-generated
     * summary so the user can continue a long conversation without
     * hitting context limits.
     *
     * Implementation: uses a structured summarization prompt (comprehensive,
     * not bullet-list) that captures decisions, file references, open
     * questions, current state, user preferences. The summary is shown in
     * chat as an "— Compaction summary —" block; the user then confirms
     * before we commit (archive old history + inject summary as system
     * prompt on next spawn). Two-step because compaction is destructive.
     *
     * Blocked while a turn is streaming (would interleave messages).
     */
    _cmdCompact(opts?: {
        auto?: boolean;
    }): Promise<void>;
    /**
     * Called from finalizeStreamingMessage when a compaction summary
     * response arrives. Renders commit/cancel controls inline below the
     * summary so the user sees what will be kept and chooses to commit.
     */
    _onCompactSummaryReady(summaryText: string): void;
    /**
     * Commit a compaction: archive the current chat-history, clear the
     * message buffer, abort the current session, and store the summary
     * so the next spawn injects it via --append-system-prompt.
     */
    _commitCompaction(summaryText: string, opts?: {
        auto?: boolean;
    }): Promise<void>;
    _cmdOpenSettings(): void;
    /**
     * Build the diagnostic context shared by /version, /status, /doctor,
     * and the /feedback prefill. Returns a plain object — callers format
     * it as text, markdown, or query-string parameters as needed.
     *
     * NEVER includes any conversation content. Only metadata.
     */
    _buildDiagnosticContext(): {
        pluginVersion: string;
        provider: string;
        model: string;
        effort: string;
        permissionMode: string;
        protectedMode: boolean;
        autoCompactSdk: boolean;
        obsidianVersion: string;
        os: string;
        messageCount: number;
        cumulativeCost: number;
        contextTokens: number;
        contextPct: number;
        windowSize: number;
        hasApiKey: boolean;
        claudeCliPath: string;
    };
    /**
     * /version — quick one-glance system info.
     */
    _cmdVersion(): void;
    /**
     * /status — unified session-status panel.
     */
    _cmdStatus(): void;
    /**
     * /doctor — diagnostics dump for bug reports. Includes a network
     * reachability test (HEAD https://api.anthropic.com/v1/) so users on
     * a corporate / firewalled network see the failure mode in the same
     * panel as the rest of the metadata.
     */
    _cmdDoctor(): Promise<void>;
    /**
     * /recap — summarize the conversation as a regular bubble without
     * committing the compaction. Useful mid-conversation snapshot.
     * Reuses the same summary prompt as /compact for consistency.
     */
    _cmdRecap(): Promise<void>;
    /**
     * /init — scaffold Gryphon/MANUAL.md if it doesn't already exist.
     * Won't overwrite an existing file. Opens the file for editing if
     * it was created.
     */
    _cmdInitManual(): Promise<void>;
    /**
     * /feedback — open a modal that lets the user pick how they want to
     * send feedback. With args, defaults to mailto with the args as body.
     * Never auto-sends; every path opens a draft (browser tab or mail
     * composer) for the user to review and submit manually.
     *
     * Diagnostic context (versions, provider, mode) is prefilled. NO
     * conversation content is included unless the user pastes it.
     */
    _cmdFeedback(arg: string): void;
    _buildFeedbackDiagText(): string;
    _openFeedbackMailto(userText: string): void;
    _openFeedbackIssueTracker(userText: string): void;
    _showFeedbackModal(): void;
    /**
     * /help — show all slash commands and keyboard shortcuts in a modal.
     * The slash list is the authoritative inventory in constants.js, so
     * this stays drift-free as commands are added.
     */
    _cmdShowHelp(): void;
    /**
     * F3 (v1.7.0) — auto-memory audit modal.
     *
     * Lists files in `~/.claude/projects/<escaped-vault>/memory/` with
     * size + age, lets the user select stale entries, and moves the
     * selection to `memory-archive/` (a sibling that CC doesn't scan).
     * The MEMORY.md index file gets the same names commented out so the
     * tree stays consistent. An Undo button on a 5-second toast reverses
     * the batch.
     */
    _cmdMemoryAudit(): Promise<void>;
    /**
     * Detect a skill invocation and return the expanded prompt, or null
     * if the input doesn't name a registered skill. Expansion substitutes
     * `{{args}}` in the skill body with whatever the user typed after the
     * command name (may be empty).
     */
    _maybeExpandSkill(text: string): string;
    stopStreaming(): void;
    /**
     * Single source of truth for tearing down streaming state. Both
     * `stopStreaming()` (user-initiated) and the connection-timeout handler
     * (time-initiated) go through here to prevent the two paths from
     * drifting apart (R3-1 was exactly that divergence: timeout forgot to
     * reset `sendBtn` and null `claudeProcess`).
     *
     * Options:
     *   bubbleText   — if provided and streamingEl exists, calls
     *                  finalizeStreamingMessage(bubbleText, doneStatus) to
     *                  seal the bubble and set the status bar.
     *   doneStatus   — passed to finalizeStreamingMessage; becomes the
     *                  status-bar text after the turn (e.g. "Stopped",
     *                  "Timed out").
     *   fallbackFlash — if no bubble exists to finalize, this string is
     *                   flashed to the status bar instead.
     *
     * Always performs: abort+null claudeProcess, isStreaming=false, queued
     * prompts cleared. These cannot be skipped — they're the invariant.
     */
    _cleanupStreamingState({ bubbleText, doneStatus, fallbackFlash }?: {
        bubbleText?: string;
        doneStatus?: string;
        fallbackFlash?: string;
    }): void;
    /**
     * Issue #36: walk back from the tail of `this.messages` and tag the
     * most recent unflagged `source: "llm"`, `role: "user"` entry with
     * `failed: true`. Called by every abort/timeout cleanup so the save
     * filter preserves prompts the CLI never received. Bounded scan (10
     * entries) — the user prompt is at most a few entries back from the
     * tail in any abort scenario.
     */
    _markLastUserPromptFailed(): void;
    _enqueuePrompt(text: string): void;
    /**
     * Cleanup queued prompts on stop / timeout / error. Removes the DOM
     * bubbles AND restores the oldest queued text to the input box if the
     * box is empty (so the user can re-fire it with one keystroke).
     * Texts stay recorded in `_pendingQueuedTexts` so up-arrow recall can
     * still walk back to any queued message that didn't get a chance to
     * fire — this is what protects the user from "I queued 3 messages
     * during a slow turn, the model timed out, and now they're all gone."
     */
    _clearQueuedPrompts(): void;
    _drainQueuedPrompts(): void;
    /**
     * Decide whether to start an auto-compact. Returns true if a
     * compaction was triggered (caller should NOT drain queued prompts —
     * the auto-compact's commit handler will drain instead). Returns
     * false otherwise.
     *
     * @param {{ lagFailsafe?: boolean, retryText?: string }} opts
     *   lagFailsafe — bypasses the percentage threshold; used by
     *                 sendMessage's catch branch when the SDK returned
     *                 "prompt is too long" despite our last reading
     *                 being below 95%.
     *   retryText  — original user text to re-send post-commit. Set on
     *                the lag-failsafe path so the user's intended message
     *                still reaches the model.
     */
    _maybeStartAutoCompact(opts?: {
        lagFailsafe?: boolean;
        retryText?: string;
    }): boolean;
    /**
     * Last-resort defense when the compaction's own summarization turn
     * overflows the context window. Drops the oldest entries from the
     * SDK provider's in-memory history array, keeping only the most
     * recent `keepRecent` turns. Returns true if any trimming happened
     * (caller should retry the summary turn). Returns false if there's
     * nothing to trim or the provider doesn't expose a history (e.g.,
     * CC mode — but this path is gated to SDK mode upstream anyway).
     *
     * Anthropic message-pair invariant: messages must alternate user /
     * assistant. After splicing we may land on an assistant turn first;
     * trim one extra so the slice starts with a user turn.
     */
    _emergencyTrim(provider: ChatProvider | null, keepRecent?: number): boolean;
    /**
     * Project the persisted UI-message log into Anthropic-API message
     * shape for SDK seeding. Drops system notices, slash-command chatter,
     * and mechanical messages — only user ↔ assistant LLM exchanges go
     * into the model's context. Returns [] if there's nothing to seed.
     *
     * Cap: last MAX_SDK_SEED_TURNS entries, to keep token cost bounded
     * after long conversations. Users who need more can /clear and start
     * fresh, or the model can reason from the persisted UI history shown
     * above the input box.
     */
    /**
     * Issue #30: stats from the last `_extractLlmTurnsFromFullHistory`
     * call. `dropped` is the count of llm turns that were over the cap
     * and got silently truncated. Used by the provider-change notice
     * (#29) to surface truncation to the user instead of letting it
     * happen invisibly.
     *
     * Stored on `this` rather than threaded through return shapes so the
     * existing call sites (which only consume the seed array) don't have
     * to change. Read AFTER calling `_extractLlmTurnsFromFullHistory`.
     */
    _extractLlmTurnsFromFullHistory(): {
        role: string;
        content: string;
    }[];
    /**
     * Issue #28: handler for /new (and /reset-context alias). Inserts a
     * boundary marker into the persisted history so the NEXT seed-history
     * extraction (when the next provider instance is constructed) drops
     * everything before the marker. Visible chat is untouched — the user
     * can still scroll back to see what they typed.
     *
     * Marker shape:
     *   { role: "system", source: "context-reset", text: "...", ts, sessionId }
     *
     * `source: "context-reset"` is a NEW source value. `filterMessagesForSave`
     * preserves it (only LLM messages of the current session are dropped on
     * save), and `_extractLlmTurnsFromFullHistory` looks for it explicitly.
     */
    _cmdResetContext(): void;
    /**
     * Return (and clear) the pending SDK seed history. One-shot — after
     * the first createProvider consumes it, subsequent calls get [].
     */
    _consumeRestoredLlmHistory(): {
        role: string;
        content: string;
    }[];
    /**
     * Prompt history for terminal-style ArrowUp/Down navigation. Derived
     * from the persisted message log so it survives reloads — the user's
     * "last 50 prompts" stay accessible even after closing Obsidian.
     *
     * Cached per-open to avoid re-scanning messages on every keystroke,
     * but invalidated each time a new user message is sent (in
     * addUserMessage) so freshly sent prompts are immediately recallable.
     */
    /**
     * Remove the auto-injected [gryphon-context]...[/gryphon-context] block
     * from a user-message text. Historically a bug (or older build) may
     * have persisted the full composite — the block + the user's typed
     * text — into chat-history.json. Reading it back would then show the
     * whole composite when the user hit ↑ to recall their prompt. Strip
     * defensively at every read site so old on-disk history stops
     * surfacing the block.
     */
    _stripContextBlock(text: string): string;
    /**
     * Derive trigger keywords from the user's active protected-pattern
     * lists PLUS a small hardcoded natural-language verb list. Returns
     * a lowercased Set for case-insensitive `.has()` checks.
     *
     * The natural-language verbs are hardcoded because regex patterns
     * like `\brm\s+\S` don't contain the English word "delete" that a
     * user typically types in their prompt. We need both: pattern-
     * extracted command names (rm, Remove-Item, del, sudo, curl, iex,
     * schtasks, etc.) AND natural-language intent verbs (delete, remove,
     * install, execute, run, etc.).
     *
     * Cached per plugin-settings snapshot; recomputed if the user edits
     * their custom patterns mid-session.
     */
    _buildTriggerKeywords(): Set<string>;
    /**
     * Return the reminder block to inject when a trigger keyword is
     * detected. Kept short (~60 tokens) because it accumulates on every
     * triggered turn. The directive focuses on the single most-observed
     * drift pattern (adding preamble/epilogue to refusal reasons); other
     * directives live in the system prompt and don't need re-emphasis
     * per-turn.
     */
    _buildReminderBlock(): string;
    /**
     * Heuristic: does this prompt look like a compound request that
     * includes a destructive sub-task? Used to inject a stronger
     * per-turn reminder when SDK models otherwise silently drop the
     * destructive half of "summarize X and delete Y" — RLHF safety
     * bias makes them skip the rm step even when the system prompt
     * tells them not to. The user already configured Gryphon to
     * decide what's allowed; the model's job is to ATTEMPT every
     * sub-task and let Gryphon answer. A per-turn reminder placed
     * adjacent to the user message moves the directive from
     * "general guidance" (system prompt) to "applies right now"
     * (recency + adjacency lift compliance on smaller models).
     *
     * Detection: keyword-based, case-insensitive. Conservative —
     * false positives just add ~80 tokens, no behavior change. We
     * only trigger when a destructive verb appears AND the prompt
     * has at least one connector ("and", "then", ".", "+", semicolon)
     * suggesting multiple sub-tasks. Single-request prompts ("delete
     * /tmp/x") don't need the compound reminder; the SDK system
     * prompt's single-request rule already handles them.
     */
    _shouldInjectCompoundReminder(text: string): boolean;
    /**
     * Per-turn compound-request reminder. Strong, concrete, with the
     * explicit instruction to call the tool. Placed adjacent to the
     * user message (after _buildReminderBlock) so the model parses
     * it as part of "what to do for THIS request" rather than as
     * abstract guidance.
     */
    _buildCompoundReminderBlock(): string;
    /**
     * Post-deny clarifier reminder. Fires on the turn IMMEDIATELY
     * AFTER a turn that ended with a Gryphon protected-pattern
     * refusal. The aim: counter the model's "I already did this; this
     * must be a system-only repeat" inference that surfaces on
     * long-running CC processes when the prior turn ended in a deny
     * (observed: Claude Code on Linux, attempt 2 of "summarize and
     * delete X" responded with "your message came through empty").
     *
     * Why a per-turn reminder (vs killing the CC process):
     *   - Kill+respawn would lose all conversation context — bad UX
     *     for multi-turn work where only the LATEST sub-task got
     *     refused.
     *   - String-match on user prompt would miss valid variations
     *     ("rm X" vs "delete X" vs "remove X" — same intent).
     *   - This reminder triggers on the actual prior OUTCOME (the
     *     deny was emitted to the user), not on prompt wording.
     *
     * One-shot — fires only on the very next turn, then the trigger
     * flag clears. Doesn't accumulate or repeat across multiple turns
     * after a single deny.
     */
    _buildPostDenyClarifierBlock(): string;
    /**
     * Set when the just-finalized assistant turn contained the
     * canonical Gryphon protected-deny marker. Read by the next send
     * to decide whether to inject the post-deny clarifier reminder.
     * One-shot — _maybeInjectPostDenyClarifier clears it after firing.
     */
    _markPriorTurnDenyIfPresent(text: string): void;
    /**
     * One-shot accessor — returns the post-deny clarifier block when
     * the flag is set, else empty string. Clears the flag in either
     * branch (one shot).
     */
    _consumePostDenyClarifier(): string;
    /**
     * Returns true if the user's text contains any trigger keyword.
     * Case-insensitive substring match (word-boundary not enforced —
     * trigger words in compound text like "protectedCommand" would fire
     * too, which is acceptable since false positives only cost ~60
     * tokens and don't change behaviour).
     */
    _shouldInjectReminder(text: string): boolean;
    _getPromptHistory(): string[];
    _invalidatePromptHistoryCache(): void;
    _setInputFromHistory(text: string): void;
    _chatHistoryPath(): string;
    /**
     * Persist local-only messages (plugin-authored — slash commands, system
     * notices) to chat-history.json. The local CLI owns LLM turns in its
     * own .jsonl session file; we don't duplicate them here.
     *
     * Async + atomic: writes to a temp file, renames on success. A crash
     * mid-write leaves the original file intact. Non-blocking: callers can
     * fire-and-forget without stalling the UI.
     *
     * On failure we flash the status bar ONCE (tracking via
     * `_chatHistorySaveError`) — hammering the user on every message event
     * isn't useful, and the first notification is enough for them to notice
     * and check disk space or permissions.
     *
     * @returns {Promise<boolean>} true on success, false on failure
     */
    /**
     * Public entry. Serializes via a promise chain so concurrent callers
     * queue up instead of racing on the shared tmp file. Rapid bursts
     * (e.g. clip processing fires addSystemMessage + finalizeStreamingMessage
     * within milliseconds) used to clobber each other's tmp files, causing
     * "ENOENT on rename" on the loser and occasional history corruption.
     * The chain drops upstream failures so one bad save doesn't stall all
     * future ones.
     */
    _saveChatHistory(): Promise<boolean | void>;
    _doSaveChatHistory(): Promise<boolean>;
    /**
     * Load and merge history from both sources, sorted by timestamp.
     *
     * Source 1 (chat-history.json) is plugin-owned: we detect corruption
     * (non-empty file that fails to parse) and move it aside to a timestamped
     * backup so the user can recover manually. `_pendingLoadWarning` is set
     * so `onOpen` can surface the problem via the status bar once
     * `toolbarStatus` is ready.
     *
     * Source 2 (local CLI .jsonl) is CLI-owned: if it's corrupt or missing,
     * we log-and-continue but do NOT rename — that file belongs to the CLI.
     */
    _loadChatHistory(): ChatMessage[];
    /**
     * Issue #4: render extended-reasoning ("thinking") output as a
     * collapsed <details> disclosure inside the assistant bubble. Multiple
     * thinking blocks per turn are joined with horizontal rules so they
     * stay distinguishable when expanded. Blocks display as plain text
     * (preserving newlines) — they're internal model output, not markdown
     * authored for rendering.
     *
     * @param {HTMLElement} bubbleEl       — the .gryphon-bubble-assistant element
     * @param {string[]} thinking          — non-empty thinking strings
     * @param {HTMLElement} [insertBefore] — if provided, insert the disclosure
     *                                       before this child (so the thinking
     *                                       block sits ABOVE the response text)
     */
    _renderThinkingBlock(bubbleEl: HTMLElement, thinking: string[], insertBefore?: HTMLElement | null): void;
    _renderMessage(msg: ChatMessage): HTMLDivElement;
    _restoreChatHistory(): void;
    /**
     * Render the "scroll up for N earlier messages" hint at the top of the
     * messages pane, or remove it when no earlier messages remain. Called
     * after initial restore and after each `_loadOlderMessages` batch.
     */
    _ensureLoadMoreHint(): void;
    _loadOlderMessages(): void;
    /**
     * Returns " (est.)" when the active provider reports its cost as
     * locally-computed (Anthropic API mode) rather than server-attested (Claude Code mode).
     * Used by /cost and /usage so SDK users don't mistake the displayed
     * number for an authoritative invoice line.
     *
     * Returns "" if no provider exists yet (fresh session) — there's no
     * cost to qualify in that case.
     */
    _costSuffix(): "" | " (est.)";
    /**
     * Surface skill-load errors from the registry as a chat system message
     * so users see "X skill files failed to load — check console" rather
     * than wondering why /tag-suggest stopped autocompleting. The full
     * per-file message is in the browser console.
     */
    _surfaceSkillLoadErrors(): void;
    /**
     * If the user opens Gryphon with no provider available, show a guided
     * setup panel inside the message area instead of letting them type a
     * prompt and hit a useless "no provider available" error on send.
     *
     * The two cards adapt to runtime detection:
     *   - CLI binary detected → one-click "Use local CLI" (sets
     *     providerPreference = "cli"), with terms-compliance disclaimer
     *   - API key found (settings field or env var) → one-click "Use
     *     Anthropic API" (sets providerPreference = "sdk")
     *   - Neither detected → setup instructions on the SDK card;
     *     the CLI card points at the SDK path instead of install-promoting
     *
     * The panel is dismissible, and `refreshWelcomePanel()` lets settings
     * changes hide it without requiring a reload.
     */
    _renderWelcomePanelIfNeeded(): void;
    /**
     * Card for the local-CLI path. If a `claude` binary is detected
     * (settings override or auto-discovery), the card offers a one-click
     * switch. Otherwise the card hints that Claude Code is the advanced
     * option and recommends the Anthropic API card instead — we don't
     * install-promote Claude Code, because its licensing terms are
     * its vendor's to communicate.
     */
    _renderCliCard(parent: HTMLElement, detected: DetectedProviders): void;
    /**
     * Card for the Anthropic API (SDK) path. Recommended for most users.
     * If a key is found anywhere (settings field or env var), the card
     * offers a one-click switch. Otherwise it points the user at the
     * settings tab to paste a key.
     */
    _renderSdkCard(parent: HTMLElement, detected: DetectedProviders): void;
    /**
     * Activate a provider in one click from the welcome panel: persist the
     * preference, run the same reset hook a settings change would, and
     * refresh the panel so it disappears once a provider can resolve.
     */
    _activateProvider(preference: string): Promise<void>;
    /**
     * Issue #29: one-shot status notice that fires when the user changes
     * Provider in Settings. Wording answers the user's implicit question
     * "what happens to my conversation when I switch?" — names the new
     * provider explicitly, the seed-history turn count (so the user knows
     * how much context flows forward), and the /new escape hatch.
     *
     * Skipped on first-time setup (no prior llm turns = nothing to
     * forward = no notice needed). Skipped also when the Provider
     * preference is the same value as before (idempotent saves).
     *
     * The seed count comes from the SAME function that produces the
     * provider's actual seed (`_extractLlmTurnsFromFullHistory`) so the
     * user-visible number can never drift from what's actually sent.
     */
    _flashProviderChangeNotice(prevPreference: string, newPreference: string): void;
    /**
     * Re-evaluate whether the welcome panel should be shown. Called from
     * the settings tab after any provider-affecting change so the panel
     * disappears as soon as the user configures a provider, no reload
     * required.
     *
     * @param {boolean} forceHide  — bypass the provider check and just hide
     */
    refreshWelcomePanel(forceHide?: boolean): void;
    addSystemMessage(text: string): void;
    /**
     * Render the canonical refusal reason from a protected-pattern deny,
     * independent of what the model later says. Exists because prompt
     * engineering can't fully suppress the model's preference for adding
     * preambles ("The Gryphon hook is blocking this") and epilogues
     * ("I can't bypass this") even with explicit anti-example phrases
     * and a bulleted source format. Guaranteeing the user sees the
     * authoritative text means emitting it ourselves, not relying on
     * the model.
     *
     * Rendered as a distinct alert-styled block (CSS: .gryphon-refusal)
     * so it reads as "Gryphon telling you what happened" vs. "the model's
     * take on what happened," which can differ in vocabulary.
     *
     * Dedup: a single protected tool-use typically triggers this twice
     * in Claude Code mode (once from the PreToolUse IPC, once from the tool
     * result returning with the same reason) and once in Anthropic API mode (from
     * permission-gate). Store a short-lived hash of the last refusal
     * text; if the next call matches within a few seconds, skip.
     */
    addRefusalMessage(text: string): void;
    addUserMessage(text: string, source?: string, opts?: {
        sideNote?: boolean;
    }): void;
    startStreamingMessage(): HTMLDivElement;
    replaceStreamingContent(fullText: string): void;
    finalizeStreamingMessage(text: string, doneStatus?: string, source?: string, thinking?: string[] | null): void;
    /**
     * Flash a plugin-level message in the status bar. Transient — gets
     * overwritten by the next tool event or turn. Use this for feedback
     * that is NOT part of the LLM conversation (setting changes, /copy
     * confirmations, ambiguous-command warnings, etc.) so the chat area
     * stays reserved for user prompts and assistant responses.
     */
    _flashStatus(text: string, _durationMs?: number): void;
    /**
     * Find a non-empty selection by cascading through three sources —
     * whichever still has the user's selection wins:
     *
     *   1. CodeMirror-tracked selections in any open markdown leaf
     *      (works for Source mode and Live Preview; CodeMirror retains
     *       selection state even when the editor loses DOM focus)
     *   2. Current window DOM selection
     *      (works if somehow still valid at call time)
     *   3. Cached selection from our document-wide selectionchange listener
     *      (works for Reading mode — rendered HTML selections — and for
     *       any workflow where the user clicked into the chat input
     *       between selecting and invoking /selection)
     *
     * @returns {{text: string, file: TFile|null}|null}
     */
    _findEditorSelection(): {
        text: string;
        file: TFile | null;
    } | null;
    /**
     * Insert editor selection into the chat input as a blockquote. Called
     * by the /selection slash command (no args — discovers selection from
     * any open markdown leaf) or by the external Obsidian command
     * (passes explicit text + file — no discovery needed).
     */
    insertSelectionIntoInput(text?: string, file?: TFile | null): void;
    /**
     * Build an ephemeral context block prepended to each send. Carries the
     * active file path so the LLM can ground "this note" references without
     * the user having to name it explicitly. Token-cheap (path only) —
     * Claude can Read the file on demand via its built-in tools.
     *
     * Not persisted to chat-history.json; the user's bubble stays clean.
     * Skipped when the active file is a prior Gryphon export — otherwise an
     * open export would self-reference on every new turn.
     */
    _buildContextPrefix(): string;
    /**
     * Serialize the current conversation to a markdown note in the
     * Gryphon/Exports/ folder. Filename auto-derived from timestamp + first
     * user message, or overridden via /export <name>. The custom name is
     * slugified (path-traversal safe); collisions get a -N suffix so no
     * export silently overwrites another.
     */
    _exportConversation(customName: string): Promise<void>;
    /** Ensure a folder path exists, creating intermediate folders as needed. */
    _ensureFolder(folderPath: string): Promise<void>;
    /** Append -1, -2, ... until a non-existing path is found, to avoid silent overwrites. */
    _uniqueExportPath(folder: string, baseSlug: string): string;
    /**
     * Slugify an arbitrary user-supplied string to a safe filename component.
     * Strips path traversal, control chars, and filesystem-hostile characters.
     * Returns an empty string if nothing usable remains.
     */
    _slugify(raw: string): string;
    _deriveExportSlug(): string;
    _formatExportMarkdown(): string;
    /**
     * Status text shown when no turn is in progress. Carries the "what do I
     * do now" hint that used to be a throwaway system message bubble.
     */
    _setIdleStatus(): void;
    updateStatus(toolNameOrText: string): void;
    clearStatus(doneMessage?: string): void;
    addCostInfo(cost: number, duration: number): void;
    scrollToBottom(): void;
    _updateAutocomplete(): void;
    _renderAutocompleteMatches(text: string, matches: SlashCommandEntry[]): void;
    /**
     * Single source of truth for autocomplete item rendering. Any caller
     * adding items to the dropdown — core's /slash list, any consumer-
     * supplied source — goes through here. Guarantees:
     *   - dataset.cmd and dataset.desc are always set (so keyboard highlight
     *     and mouse hover both get the description for status preview)
     *   - mouseenter / mouseleave listeners wired (so hover-preview works)
     *   - click listener wired (so mouse click selects)
     *
     * Extracted so a new autocomplete source can't accidentally forget the
     * dataset contract, which caused past regressions where sources set
     * dataset.cmd but forgot dataset.desc or the hover listeners.
     */
    _createAcItem(parent: HTMLElement, cmd: string, desc: string): HTMLDivElement;
    _previewAcItem(el: HTMLElement): void;
    _restorePreAcStatus(): void;
    _hideAutocomplete(): void;
    _highlightAcItem(items: NodeListOf<Element>): void;
    _selectAcItem(cmd: string): void;
    /**
     * One-hop availability failover (issue #15). Thin orchestration on top of
     * the provider-runtime kernel (classifyProviderFailure / resolveFallback).
     *
     * `attempt(kind, modelOverride)` is the re-runnable construct+wire+send unit
     * supplied by sendMessage. It resolves to one of:
     *   { ok: true,  provider, result }            — sent successfully
     *   { ok: false, provider, error }             — constructed, send threw
     *   { ok: false, provider: null, error: null } — construct returned null
     *
     * Returns a decision:
     *   { outcome: "served", result, requestedProvider, servedBy, fellBack, reason }
     *   { outcome: "unavailable", result: null, ... }  — no provider, no fallback
     *                                                     (sendMessage shows
     *                                                      explainUnavailable())
     * Throws when the active failure is a genuine content/runtime error (the
     * original error, unchanged — its UX is owned by sendMessage's catch), or
     * when a fallback was attempted and also failed (one combined error).
     *
     * Only AVAILABILITY failures fail over: every such class fails BEFORE any
     * assistant content streams, so re-attempting on the fallback never
     * discards partial good output.
     */
    _runFailover(activeKind: string, attempt: FailoverAttempt): Promise<FailoverDecision>;
    /**
     * Humanized fallback attribution (issue #16). #15's signal carries raw kind
     * ids + a raw reason; here we render the user-facing message via the
     * provider-runtime kernel humanizers so the chat surface and the Settings
     * chip speak identically. Shape:
     *   "Selected: {label} (unavailable: {reason}) · Answered by: {label}"
     */
    _formatFallbackNotice(decision: FailoverDecision): string;
    /** Stamp the transparency signal onto the Result + build the served decision. */
    _stampFailoverResult(result: ProviderResult, fields: FailoverFields): FailoverDecision;
    /**
     * Why did createProvider return null for `kind`? For an API kind it is
     * almost always a missing key — report that ("no-api-key") rather than the
     * generic "construct-null". CLI kinds construct-null on a missing binary,
     * which is not a key issue, so they keep "construct-null".
     */
    _refineConstructNullReason(kind: string): "construct-null" | "no-api-key";
    sendMessage(): Promise<void>;
}
export { GryphonChatView, filterMessagesForSave, computeContextPct, shouldStartAutoCompact, nextContextWarningState, modelButtonText, modelButtonTitle, _modelOptionsForKind, _providerLabelFor, _separateCanonicalBlocks, _dedupeConsecutiveParagraphs, _collapseSummaryDrafts, _isRateLimitError, _parseRetryAfterSeconds, _replaceNoResponsePlaceholder, };
