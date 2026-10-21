// Type declarations for the provider-runtime subpaths protect imports.
//
// protect and provider-runtime import each other, and each package's types
// come from its built dist/. protect builds first (`npm run prebuild`), so on a
// fresh checkout provider-runtime's dist/*.d.ts doesn't exist yet. These
// declarations — copied from provider-runtime's generated .d.ts — let protect
// typecheck and build without it. Only what protect uses is declared;
// tests/provider-runtime-subpaths.test.ts checks every declared name still
// exists in provider-runtime.

declare module "@polleoai/gryphon-provider-runtime/shell-quote" {
  export function shQuote(s: string): string;
  export function psQuote(s: string): string;
  export function hookCommandLine(nodePath: string, scriptPath: string, platform?: string): string;
}

declare module "@polleoai/gryphon-provider-runtime/launcher-refusal-text" {
  export function launcherRefusalText(reason: string | null | undefined): { cause: string; fix: string } | null;
}

declare module "@polleoai/gryphon-provider-runtime/providers/claude-code/hook-settings-builder" {
  export const DEFAULT_HOOK_TIMEOUTS: {
    PreToolUse: number;
    PostToolUse: number;
    SessionStart: number;
    SessionEnd: number;
    UserPromptSubmit: number;
    Notification: number;
  };
  type HookEvent = keyof typeof DEFAULT_HOOK_TIMEOUTS;
  type HookGroup = { matcher: string; hooks: Record<string, string | number>[] }[];
  export const HOOK_FILES: Record<string, string>;
  export const POSTTOOL_MATCHER: "WebFetch|WebSearch|Bash|Read|Glob|Grep|Write";
  export function buildHookSettings(params: {
    pluginDir: string;
    socketPath: string;
    nodePath?: string;
    timeouts?: Partial<Record<HookEvent, number>>;
  }): { hooks: Record<HookEvent, HookGroup> };
  export function buildPermissionsOnlySettings(denyRules: unknown): { permissions: { deny: string[] } };
  export function writeHookSettingsFile(settings: unknown): string;
}

declare module "@polleoai/gryphon-provider-runtime/utils" {
  export function findClaudeBinary(): string | null;
  export function findCodexBinary(): string | null;
  export function findGeminiBinary(): string | null;
  export function findAntigravityBinary(): string | null;
  export function findNodeBinary(): string | null;
  export function _versionSignatureFor(binName: string): RegExp | undefined;
  export function probeVersion(binPath: string, run?: (p: string) => string, signature?: RegExp): number[] | null;
  export function resolveCliBinary(kind: string, configuredPath?: string, minVersionOverride?: string, opts?: {
    vaultRoot?: string | null;
  }): { ok: true; path: string; version: number[] } | { ok: false; error: "not-found" | "too-old"; detail: string };
}

declare module "@polleoai/gryphon-provider-runtime/node-fetch" {
  export interface NodeFetchInit {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Uint8Array;
    maxBytes?: number;
  }
  export interface NodeFetchResponse {
    status: number;
    headers: Record<string, string>;
    text(): Promise<string>;
    json(): Promise<unknown>;
  }
  export function nodeFetch(url: string, init?: NodeFetchInit, redirects?: number): Promise<NodeFetchResponse>;
}
