import { PassiveStreamParser } from "./stream-parser";
import type { BridgeInvoke, JsonRpcId, PassiveBridge } from "./mcp-bridge";
import type { AnthropicMessage, ContentBlock, PassiveSessionConfig, SendRequest, SendResponse } from "./types";
type TextBlock = Extract<ContentBlock, {
    type: "text";
}>;
interface UsageLike {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
}
/** A content block as it arrives on claude's stream-json stdout. */
interface StreamBlock {
    type?: string;
    text?: unknown;
    id: string;
    name: string;
    input: object;
}
/** A parsed stream-json stdout event (only the fields read here). */
interface StreamEvent {
    type?: string;
    subtype?: string;
    session_id?: string;
    message?: {
        content?: StreamBlock[];
        usage?: UsageLike;
    };
}
/** A tool call parked on the bridge, awaiting the caller's tool_result. */
interface PendingToolCall {
    toolUseId: string;
    jsonrpcId: JsonRpcId;
    bareName: string;
    input: unknown;
}
/** The claude child (a ChildProcess, or a test double via _spawnOverride). */
interface PassiveProc {
    pid?: number | null;
    exitCode?: number | null;
    signalCode?: NodeJS.Signals | null;
    kill(signal?: NodeJS.Signals | number): boolean | void;
    stdin: {
        write(chunk: string): unknown;
    };
    stdout: {
        on(event: "data", cb: (d: Buffer | string) => void): unknown;
    };
    stderr: {
        on(event: "data", cb: (d: Buffer | string) => void): unknown;
    };
    on(event: "close", cb: (code: number | null) => void): unknown;
    on(event: "error", cb: (err: Error) => void): unknown;
}
type PassiveSpawnOptions = {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: string[];
};
/** Public config plus the internal fields createPassiveSession / tests inject. */
interface PassiveSessionInit extends PassiveSessionConfig {
    claudePath?: string;
    requestTimeoutMs?: number;
    _spawnOverride?: ((args: string[], spawnOpts: PassiveSpawnOptions) => PassiveProc) | null;
    _mcpConfigPath?: string | null;
    _allowedTools?: string[] | null;
    _bridge?: PassiveBridge | null;
    _bridgeOverride?: PassiveBridge | null;
}
declare class ClaudePassiveSession {
    config: PassiveSessionInit;
    claudePath: string;
    _spawnOverride: ((args: string[], spawnOpts: PassiveSpawnOptions) => PassiveProc) | null;
    _mcpConfigPath: string | null;
    _allowedTools: string[] | null;
    _bridge: PassiveBridge | null;
    _requestTimeoutMs: number;
    process: PassiveProc | null;
    sessionId: string | null;
    _buffer: string;
    _parser: PassiveStreamParser | null;
    _pendingResolve: ((value: SendResponse) => void) | null;
    _pendingReject: ((err: Error) => void) | null;
    _turnTimer: ReturnType<typeof setTimeout> | null;
    _stderrTail: string;
    _closed: boolean;
    _broken: Error | null;
    _pendingToolCalls: PendingToolCall[];
    _turnText: TextBlock[];
    _turnDeclaredToolUse: StreamBlock[];
    _turnParked: BridgeInvoke[];
    _turnUsage: UsageLike | null;
    _settled: boolean;
    _malformed?: number;
    constructor(config: PassiveSessionInit);
    _resetTurn(): void;
    _isDeclared(name: unknown): boolean;
    _bareName(name: string): string;
    _sanitize(content: ContentBlock[]): ContentBlock[];
    _spawn(): void;
    _onStdout(data: Buffer | string): void;
    _handleEvent(parsed: StreamEvent): void;
    _onBridgeInvoke(inv: BridgeInvoke): void;
    _onBridgeDown(err: Error): void;
    _maybeSettleToolUse(): void;
    _onClose(code: number | null): void;
    _clearTurnTimer(): void;
    _resolve(value: SendResponse): void;
    _settle(value: SendResponse): void;
    _reject(err: unknown): void;
    _routeOrWrite(messages: AnthropicMessage[]): void;
    send(req: SendRequest): Promise<SendResponse>;
    _abort(): void;
    _cleanupConfigFile(): void;
    close(): Promise<void>;
}
export { ClaudePassiveSession };
export type { PassiveSessionInit };
