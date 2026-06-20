export interface DeclaredTool {
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
}
export type ContentBlock = {
    type: "text";
    text: string;
} | {
    type: "tool_use";
    id: string;
    name: string;
    input: object;
} | {
    type: "tool_result";
    tool_use_id: string;
    content: string | ContentBlock[];
    is_error?: boolean;
};
export interface AnthropicMessage {
    role: "user" | "assistant";
    content: string | ContentBlock[];
}
export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
export interface PassiveSessionConfig {
    kind: "claude-code";
    cwd: string;
    model: string;
    systemPrompt?: string;
    declaredTools: DeclaredTool[];
    maxThinkingTokens?: number;
    signal?: AbortSignal;
}
export interface SendRequest {
    messages: AnthropicMessage[];
    signal?: AbortSignal;
}
export interface PassiveUsage {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
}
export interface SendResponse {
    content: ContentBlock[];
    stop_reason: StopReason;
    usage: PassiveUsage;
    total_cost_usd: number;
    sessionId: string;
}
export interface PassiveSession {
    send(req: SendRequest): Promise<SendResponse>;
    close(): Promise<void>;
    readonly sessionId: string | null;
}
