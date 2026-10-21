/** JSON-RPC request id, echoed back verbatim to the shim. */
type JsonRpcId = string | number | null;
/** A parked tools/call forwarded by the shim. */
interface BridgeInvoke {
    jsonrpcId: JsonRpcId;
    name: string;
    input: unknown;
}
/** The tool result pushed back to unblock a parked call. */
interface BridgeResult {
    content?: unknown;
    is_error?: boolean;
}
interface PassiveBridge {
    socketPath: string;
    onInvoke(cb: (inv: BridgeInvoke) => void): void;
    onTransportError(cb: (err: Error) => void): void;
    resolve(jsonrpcId: JsonRpcId, result: BridgeResult | null | undefined): boolean;
    close(): Promise<void>;
}
declare function createBridge(): Promise<PassiveBridge>;
export { createBridge };
export type { PassiveBridge, BridgeInvoke, BridgeResult, JsonRpcId };
