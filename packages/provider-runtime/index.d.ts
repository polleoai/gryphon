// Public type declarations for @polleoai/gryphon-provider-runtime (R4/R5).
//
// Lives at the package root (committed, not in dist/) so `types`/`exports` can
// point here. src/index.ts is an ES module, so tsc emits accurate declarations
// for every runtime export into dist/index.d.ts; they are re-exported below.
// The passive-backend section keeps its published type names (DeclaredTool,
// PassiveContentBlock, PassiveSend*), which a local declaration takes
// precedence over the star export for.
//
// Consumers (Metis):
//   import { createProvider, type LLMProvider, type SendOptions } from "@polleoai/gryphon-provider-runtime";

export * from "./dist/index";

export type {
  LLMProvider,
  SendOptions,
  Result,
  StructuredOutputRequest,
  StreamMessageType,
  ProviderKind,
} from "./dist/types";

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
