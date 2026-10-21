import type { DeclaredTool } from "./types";
declare const MCP_SERVER_NAME = "gryphon-passive";
declare function namespacedToolName(bare: string): string;
declare function writeMcpConfigFile(mcpServers: Record<string, unknown>, prefix?: string): string;
declare function buildMcpConfig(declaredTools: DeclaredTool[], opts: {
    shimEntry: string;
    socketPath: string;
}): {
    json: {
        mcpServers: {
            "gryphon-passive": {
                command: string;
                args: string[];
                env: {
                    GRYPHON_PASSIVE_SOCKET: string;
                    GRYPHON_PASSIVE_TOOLS: string;
                };
            };
        };
    };
    jsonPath: string;
};
export { buildMcpConfig, writeMcpConfigFile, namespacedToolName, MCP_SERVER_NAME };
