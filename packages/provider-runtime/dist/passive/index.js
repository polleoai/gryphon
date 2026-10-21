"use strict";
// packages/provider-runtime/src/passive/index.ts
// Public entry for passive-backend mode: claude as a structured LLM backend
// (Anthropic Messages-API content blocks) for callers that own tool execution.
//
// See docs/superpowers/specs/2026-06-14-passive-backend-design.md.
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
exports.createPassiveSession = createPassiveSession;
const path = __importStar(require("path"));
const claude_passive_session_1 = require("./claude-passive-session");
const mcp_bridge_1 = require("./mcp-bridge");
const mcp_config_builder_1 = require("./mcp-config-builder");
function validateDeclaredTools(tools) {
    if (!Array.isArray(tools))
        throw new Error("declaredTools must be an array");
    for (const t of tools) {
        if (!t || typeof t.name !== "string" || !t.name)
            throw new Error("each declaredTool needs a non-empty name");
        if (typeof t.description !== "string")
            throw new Error(`declaredTool ${t && t.name}: description must be a string`);
        if (!t.input_schema || typeof t.input_schema !== "object")
            throw new Error(`declaredTool ${t.name}: input_schema must be an object`);
    }
}
async function createPassiveSession(config) {
    if (!config || typeof config !== "object")
        throw new Error("config is required");
    if (config.kind !== "claude-code")
        throw new Error(`unsupported kind: ${config.kind}`); // runtime value from an untyped caller
    if (!config.cwd || typeof config.cwd !== "string")
        throw new Error("cwd is required (explicit, never process.cwd())");
    if (!config.model || typeof config.model !== "string")
        throw new Error("model is required");
    const declared = config.declaredTools || [];
    validateDeclaredTools(declared);
    // Phase B: when tools are declared, stand up the parking bridge + MCP shim
    // config and pre-authorize the namespaced tools (spike refinement #2).
    let bridge = config._bridge || null;
    let mcpConfigPath = config._mcpConfigPath || null;
    let allowedTools = null;
    if (declared.length > 0) {
        bridge = config._bridgeOverride || bridge || (await (0, mcp_bridge_1.createBridge)());
        allowedTools = declared.map((t) => (0, mcp_config_builder_1.namespacedToolName)(t.name));
        if (!mcpConfigPath && !config._spawnOverride) {
            const shimEntry = path.join(__dirname, "mcp-shim", "server.cjs");
            mcpConfigPath = (0, mcp_config_builder_1.buildMcpConfig)(declared, { shimEntry, socketPath: bridge.socketPath }).jsonPath;
        }
    }
    return new claude_passive_session_1.ClaudePassiveSession({
        ...config,
        declaredTools: declared,
        _bridge: bridge,
        _mcpConfigPath: mcpConfigPath,
        _allowedTools: allowedTools,
    });
}
