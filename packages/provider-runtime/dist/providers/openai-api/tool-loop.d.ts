/**
 * OpenAI tool-use loop driver.
 *
 * Mirror of anthropic-api/tool-loop.js but speaks OpenAI's tool-call shape:
 *
 *   1. Send messages (with tools[]) → SDK streams content deltas + tool-call deltas
 *   2. If finish_reason === "tool_calls", collect the tool_calls list
 *   3. Execute each tool locally → build tool-result messages (role: "tool")
 *   4. Append assistant turn (with tool_calls) + tool result messages to history
 *   5. Loop until finish_reason !== "tool_calls"
 *
 * Tool execution goes through Gryphon's existing executeTool() from
 * anthropic-api/tools/tool-registry, so the protected-pattern guardrails
 * (attack-detector PreToolUse classification, permission-gate prompts,
 * per-tool input scrubbing) fire identically regardless of which provider
 * triggered the call. This is the v1.2 security parity guarantee — Stage 4
 * re-validates against synthetic GPT outputs.
 *
 * History invariant (mirrors anthropic-api/tool-loop.js): `history` is
 * mutated IN PLACE so the caller's send() can roll back to a pre-turn
 * checkpoint on thrown error. Do not clone the array internally.
 */
import type OpenAI from "openai";
type ChatMessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type OpenAIChatStream = ReturnType<OpenAI["chat"]["completions"]["stream"]>;
type OpenAIStreamParams = Parameters<OpenAI["chat"]["completions"]["stream"]>[0];
type OpenAIUsage = Partial<OpenAI.Completions.CompletionUsage>;
type OpenAIToolLoopContext = {
    responseFormat?: OpenAIStreamParams["response_format"] | null;
    maxUsdBudget?: number | null;
    computeIterationCost?: ((usage: OpenAIUsage) => number) | null;
    priorCumulativeCost?: number;
    _loopCost?: number;
    [key: string]: unknown;
};
interface OpenAIToolLoopCallbacks {
    onMessage?: (text: string, type: string) => void;
    onTool?: (name: string) => void;
    onError?: (text: string) => void;
    onStream?: (stream: OpenAIChatStream) => void;
}
declare const MAX_ITERATIONS = 25;
declare function runOpenAIToolLoop({ client, model, systemPrompt, history, ctx, callbacks, }: {
    client: OpenAI;
    model: string;
    systemPrompt: string | null | undefined;
    history: ChatMessageParam[];
    ctx: OpenAIToolLoopContext;
    callbacks: OpenAIToolLoopCallbacks;
}): Promise<{
    turnText: string;
    finalMessage: {
        role: string;
        content: string;
    } | null;
    totalUsage: {
        prompt_tokens: number;
        completion_tokens: number;
        prompt_tokens_details: {
            cached_tokens: number;
        };
    };
    peakUsage: {
        prompt_tokens: number;
    };
    iterations: number;
}>;
/**
 * Convert the Anthropic-shape tool result `content` array into the single
 * string OpenAI expects on `role: "tool"` messages. Any `is_error` flag is
 * surfaced inline as a prefix so the model can still recognize errors —
 * OpenAI's `role: "tool"` shape doesn't have a structured error field.
 */
declare function serializeToolResultContent(result: {
    content?: unknown;
    isError?: boolean;
} | null | undefined): string;
export { runOpenAIToolLoop, MAX_ITERATIONS, serializeToolResultContent, };
