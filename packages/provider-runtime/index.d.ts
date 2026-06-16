// Hand-maintained public type declarations for @gryphon/provider-runtime (R4/R5).
//
// Lives at the package root (committed, not in dist/) so `types`/`exports` can
// point here without requiring a build. The runtime is CommonJS
// (`module.exports = {...}` in src/index.ts), which tsc cannot statically
// analyze into named declarations — so the public surface is declared by hand
// here, sourced from the compiled dist/types.d.ts for the shared types.
//
// Keep in sync with src/index.ts's module.exports. Consumers (Metis):
//   import { createProvider, type LLMProvider, type SendOptions } from "@gryphon/provider-runtime";

export type {
  LLMProvider,
  SendOptions,
  Result,
  StructuredOutputRequest,
  StreamMessageType,
  ProviderKind,
} from "./dist/types";

import type { LLMProvider, ProviderKind } from "./dist/types";

// ── provider selection / instantiation (factory) ──────────────────────
/** Construct a provider from a plugin instance OR a `{kind, config, cwd?, options?, hostAdapter?}` bag. Returns null when the selected provider is unavailable. */
export declare function createProvider(
  pluginOrBag: any,
  cwd?: string,
  options?: Record<string, any>,
): LLMProvider | null;
/** Human-readable reason the active provider can't run (missing key/CLI, etc.). */
export declare function explainUnavailable(plugin: any): string;
/** Probe which providers are usable in the current environment. */
export declare function detectAvailable(plugin: any): any;
/** The resolved active provider kind, or null if none is available. */
export declare function getActiveProviderKind(plugin: any): ProviderKind | null;

// ── binary / environment discovery (utils) ────────────────────────────
export declare function findClaudeBinary(): string | null;
export declare function findCodexBinary(): string | null;
export declare function findGeminiBinary(): string | null;
export declare function findNodeBinary(): string | null;
export declare function buildEnhancedPath(): string;
export declare function detectFlatpakSandbox(): { isFlatpak: boolean; appId: string | null };
export declare function clearBinaryDiscoveryCache(): void;
export declare function displayPath(p: unknown): unknown;

// ── namespaces (advanced/internal access) ─────────────────────────────
export declare const factory: any;
export declare const utils: any;
export declare const pricing: {
  anthropic: any;
  openai: any;
  google: any;
};

// ── subprocess lifecycle (registry) ───────────────────────────────────
/** Reap every CLI child process tree the runtime spawned. Call from the host's shutdown path (Obsidian onunload). Idempotent; never throws. Returns the number of trees signalled. */
export declare function killAllSubprocesses(signal?: NodeJS.Signals): number;
/** Number of currently-tracked (presumed-live) CLI children. Diagnostics. */
export declare function liveSubprocessCount(): number;
export declare const subprocessRegistry: any;

// ── error types thrown by send() ──────────────────────────────────────
export declare class BudgetExceededError extends Error {
  constructor(...args: any[]);
}
export declare class CliStructuredOutputError extends Error {
  reason?: string;
  constructor(...args: any[]);
}

// ── passive-backend mode (passive/) ───────────────────────────────────
// claude as a structured LLM backend: emits Anthropic Messages-API content
// blocks (text + tool_use); the CALLER executes the tools. See src/passive/README.md.
export interface DeclaredTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}
export type PassiveContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: object }
  | { type: "tool_result"; tool_use_id: string; content: string | PassiveContentBlock[]; is_error?: boolean };
export interface PassiveSessionConfig {
  kind: "claude-code";
  cwd: string;
  model: string;
  systemPrompt?: string;
  declaredTools: DeclaredTool[];
  maxThinkingTokens?: number;
  signal?: AbortSignal;
}
export interface PassiveSendRequest {
  messages: Array<{ role: "user" | "assistant"; content: string | PassiveContentBlock[] }>;
  signal?: AbortSignal;
}
export interface PassiveSendResponse {
  content: PassiveContentBlock[];
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
  usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number };
  total_cost_usd: number;
  sessionId: string;
}
export interface PassiveSession {
  send(req: PassiveSendRequest): Promise<PassiveSendResponse>;
  close(): Promise<void>;
  readonly sessionId: string | null;
}
/** Create a passive claude backend session. Tools are declared, not executed by gryphon. */
export declare function createPassiveSession(config: PassiveSessionConfig): Promise<PassiveSession>;
