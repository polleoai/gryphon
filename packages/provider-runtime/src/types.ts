// The public, Metis-consumed contract (R4). Verified vs provider-interface.js + index.js.
// G3: types are erased at runtime — the providers' runtime validation/parse/retry stays.

export type ProviderKind =
  | "anthropic-api" | "openai-api" | "google-api"
  | "claude-code"   | "codex-cli"  | "gemini-cli";

export type StreamMessageType = "init" | "replace" | "tool";

export interface StructuredOutputRequest {
  name: string;
  schema: object;          // JSON Schema
  maxRetries?: number;     // CLI providers only; default 3
}

export interface SendOptions {
  structuredOutput?: StructuredOutputRequest;
  maxUsdBudget?: number;   // hard per-call cost cap → throws BudgetExceededError
}

export interface Result {
  text: string;
  cost: number;            // USD this turn
  cumulativeCost: number;  // USD across the session
  sessionId: string | null;
  duration: number;        // ms
  contextTokens: number;
  thinking?: unknown;      // present when model returns thinking blocks (anthropic-api)
  json?: unknown;          // present iff structuredOutput was set (schema-validated)
}

export interface LLMProvider {
  send(prompt: string, options?: SendOptions): Promise<Result>;
  abort(): void;
  isAlive(): boolean;
  onMessage?: (text: string, type: StreamMessageType) => void;
  onError?:   (text: string) => void;
  onDone?:    (result: Result) => void;
  readonly sessionId: string | null;
  readonly resolvedModel: string | null;
  readonly contextTokens: number;
}
