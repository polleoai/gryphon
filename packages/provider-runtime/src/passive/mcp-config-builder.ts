// packages/provider-runtime/src/passive/mcp-config-builder.ts
// Builds the --mcp-config JSON declaring the passive shim as the ONLY MCP
// server (paired with --strict-mcp-config). The shim is spawned by claude as
// `node <shimEntry>`; it receives the declared tools + the gryphon-side bridge
// socket path via env. See design spec §6 + §12.

const fs = require("fs") as typeof import("fs");
const os = require("os") as typeof import("os");
const path = require("path") as typeof import("path");

// MCP exposes tools to the model namespaced as mcp__<server>__<tool>.
const MCP_SERVER_NAME = "gryphon-passive";

function namespacedToolName(bare: string): string {
  return `mcp__${MCP_SERVER_NAME}__${bare}`;
}

let _counter = 0;
function uniqueTmp(prefix: string, ext: string): string {
  _counter += 1;
  return path.join(os.tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${_counter}${ext}`);
}

// declaredTools: Array<{name, description, input_schema}>
// opts: { shimEntry: string, socketPath: string }
function buildMcpConfig(declaredTools: any[], opts: any): any {
  const json = {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        command: "node",
        args: [String(opts.shimEntry)],
        env: {
          GRYPHON_PASSIVE_SOCKET: String(opts.socketPath),
          GRYPHON_PASSIVE_TOOLS: JSON.stringify(declaredTools || []),
        },
      },
    },
  };
  const jsonPath = uniqueTmp("gryphon-passive-mcp", ".json");
  fs.writeFileSync(jsonPath, JSON.stringify(json), "utf8");
  return { json, jsonPath };
}

export { buildMcpConfig, namespacedToolName, MCP_SERVER_NAME };