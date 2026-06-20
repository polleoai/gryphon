"use strict";
// packages/provider-runtime/src/passive/index.ts
// Public entry for passive-backend mode: claude as a structured LLM backend
// (Anthropic Messages-API content blocks) for callers that own tool execution.
//
// See docs/superpowers/specs/2026-06-14-passive-backend-design.md.
Object.defineProperty(exports, "__esModule", { value: true });
const path = require("path");
const { ClaudePassiveSession } = require("./claude-passive-session");
const { createBridge } = require("./mcp-bridge");
const { buildMcpConfig, namespacedToolName } = require("./mcp-config-builder");
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
        throw new Error(`unsupported kind: ${config.kind}`);
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
        bridge = config._bridgeOverride || bridge || (await createBridge());
        allowedTools = declared.map((t) => namespacedToolName(t.name));
        if (!mcpConfigPath && !config._spawnOverride) {
            const shimEntry = path.join(__dirname, "mcp-shim", "server.cjs");
            mcpConfigPath = buildMcpConfig(declared, { shimEntry, socketPath: bridge.socketPath }).jsonPath;
        }
    }
    return new ClaudePassiveSession({
        ...config,
        declaredTools: declared,
        _bridge: bridge,
        _mcpConfigPath: mcpConfigPath,
        _allowedTools: allowedTools,
    });
}
module.exports = { createPassiveSession };
