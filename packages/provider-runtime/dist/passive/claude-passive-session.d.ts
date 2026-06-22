declare class ClaudePassiveSession {
    [key: string]: any;
    constructor(config: any);
    _resetTurn(): void;
    _isDeclared(name: any): boolean;
    _bareName(name: any): string;
    _sanitize(content: any[]): any[];
    _spawn(): void;
    _onStdout(data: any): void;
    _handleEvent(parsed: any): void;
    _onBridgeInvoke(inv: any): void;
    _onBridgeDown(err: any): void;
    _maybeSettleToolUse(): void;
    _onClose(code: any): void;
    _clearTurnTimer(): void;
    _resolve(value: any): void;
    _settle(value: any): void;
    _reject(err: any): void;
    _routeOrWrite(messages: any[]): void;
    send(req: any): Promise<any>;
    _abort(): void;
    _cleanupConfigFile(): void;
    close(): Promise<void>;
}
export { ClaudePassiveSession };
