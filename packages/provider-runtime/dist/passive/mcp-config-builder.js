"use strict";
// packages/provider-runtime/src/passive/mcp-config-builder.ts
// Builds the --mcp-config JSON declaring the passive shim as the ONLY MCP
// server (paired with --strict-mcp-config). The shim is spawned by claude as
// `node <shimEntry>`; it receives the declared tools + the gryphon-side bridge
// socket path via env. See design spec §6 + §12.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.MCP_SERVER_NAME = void 0;
exports.buildMcpConfig = buildMcpConfig;
exports.writeMcpConfigFile = writeMcpConfigFile;
exports.namespacedToolName = namespacedToolName;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
// MCP exposes tools to the model namespaced as mcp__<server>__<tool>.
const MCP_SERVER_NAME = "gryphon-passive";
exports.MCP_SERVER_NAME = MCP_SERVER_NAME;
function namespacedToolName(bare) {
    return `mcp__${MCP_SERVER_NAME}__${bare}`;
}
let _counter = 0;
function uniqueTmp(prefix, ext) {
    _counter += 1;
    return path.join(os.tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${_counter}${ext}`);
}
// Write an `{ mcpServers }` map to a fresh temp file for `--mcp-config` and
// return its path. `wx` refuses to write through a pre-planted file/symlink;
// `0600` keeps server commands + env (which may carry tokens) owner-only.
// Shared by the passive backend and the claude-code provider's scoped
// launch (issue #25). The caller owns unlinking the file.
function writeMcpConfigFile(mcpServers, prefix = "gryphon-mcp") {
    const jsonPath = uniqueTmp(prefix, ".json");
    fs.writeFileSync(jsonPath, JSON.stringify({ mcpServers }), { encoding: "utf8", flag: "wx", mode: 0o600 });
    return jsonPath;
}
// declaredTools: Array<{name, description, input_schema}>
// opts: { shimEntry: string, socketPath: string }
function buildMcpConfig(declaredTools, opts) {
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
    const jsonPath = writeMcpConfigFile(json.mcpServers, "gryphon-passive-mcp");
    return { json, jsonPath };
}
