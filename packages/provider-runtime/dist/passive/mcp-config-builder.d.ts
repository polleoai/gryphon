declare const MCP_SERVER_NAME = "gryphon-passive";
declare function namespacedToolName(bare: string): string;
declare function writeMcpConfigFile(mcpServers: Record<string, any>, prefix?: string): string;
declare function buildMcpConfig(declaredTools: any[], opts: any): any;
export { buildMcpConfig, writeMcpConfigFile, namespacedToolName, MCP_SERVER_NAME };
