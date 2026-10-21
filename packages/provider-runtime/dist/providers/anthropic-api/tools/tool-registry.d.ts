/**
 * Tool registry — single source of truth for SDK-mode tool schemas and
 * dispatchers.
 *
 * Tools register themselves by adding to TOOLS_BY_PHASE; the schemas
 * shipped to the API are derived from the active set, scoped by which
 * phases are enabled (read-only Phase 3, +write Phase 4, +bash/web
 * Phase 5). Permission-gated tools (Write/Edit/Bash) check the caller's
 * permissionMode in their execute() before performing the side effect.
 */
interface ToolResult {
    content: string | Array<{
        type: string;
        text: string;
    }>;
    isError?: boolean;
}
interface ToolSchema {
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
}
interface ToolModule {
    SCHEMA: ToolSchema;
    execute(input: unknown, ctx: unknown): Promise<ToolResult>;
}
interface ToolPhaseOpts {
    allowWrite?: boolean;
    allowWeb?: boolean;
    allowBash?: boolean;
}
/**
 * Returns the active tool set based on which phases are enabled.
 * @param {object} opts — { allowWrite, allowWeb, allowBash }
 * @returns {Array<{SCHEMA, execute}>}
 */
declare function getActiveTools(opts?: ToolPhaseOpts): ToolModule[];
/**
 * Returns the schema array shipped to the Anthropic API.
 */
declare function getToolSchemas(opts?: ToolPhaseOpts): ToolSchema[];
/**
 * Dispatch a tool_use block to its execute() handler.
 * Always returns a tool_result-shaped object; throws never escape.
 *
 * Phase gating is enforced at schema-ship time (see getToolSchemas): a
 * tool whose phase is disabled never reaches the model in the first place,
 * so the model can't name it in a tool_use block. This dispatcher matches
 * that posture — it accepts any registered tool name. If phases ever
 * need to be enforced at dispatch too (e.g., when ship-time and
 * dispatch-time schemas can diverge), pass `opts` through from the caller.
 *
 * @param {string} name   — tool name from the model's tool_use block
 * @param {object} input  — tool input args from the model
 * @param {object} ctx    — { vaultRoot, permissionMode, plugin, ... }
 * @returns {Promise<{content, isError}>}
 */
declare function executeTool(name: string, input: unknown, ctx: unknown): Promise<ToolResult>;
export { getActiveTools, getToolSchemas, executeTool };
