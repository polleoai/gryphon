declare const DISALLOWED_BUILTINS: string[];
interface PassiveArgConfig {
    model: string;
    systemPrompt?: string | null;
    maxThinkingTokens?: number;
}
interface PassiveArgOptions {
    allowedTools?: string[];
    mcpConfigPath?: string;
}
declare function buildPassiveArgs(config: PassiveArgConfig, opts?: PassiveArgOptions): string[];
export { buildPassiveArgs, DISALLOWED_BUILTINS };
