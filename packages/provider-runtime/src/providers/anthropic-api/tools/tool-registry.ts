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

import * as Read from "./read";
import * as Glob from "./glob";
import * as Grep from "./grep";
import * as Write from "./write";
import * as Edit from "./edit";
import * as WebFetch from "./web-fetch";
import * as WebSearch from "./web-search";
import * as Bash from "./bash";

// tool_result-shaped value every tool's execute() resolves to.
interface ToolResult {
  content: string | Array<{ type: string; text: string }>;
  isError?: boolean;
}

// Anthropic-shape tool schema ({ name, description, input_schema }).
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

// Tool sets, grouped by phase. Each phase gates additional capabilities
// in the tool-loop so we can experiment with subsets if needed.
const READ_ONLY_TOOLS: ToolModule[] = [Read, Glob, Grep];
const WRITE_TOOLS: ToolModule[] = [Write, Edit];
const WEB_BASH_TOOLS: ToolModule[] = [WebFetch, WebSearch, Bash];

/**
 * Returns the active tool set based on which phases are enabled.
 * @param {object} opts — { allowWrite, allowWeb, allowBash }
 * @returns {Array<{SCHEMA, execute}>}
 */
function getActiveTools(opts: ToolPhaseOpts = {}): ToolModule[] {
  const tools = [...READ_ONLY_TOOLS];
  if (opts.allowWrite) tools.push(...WRITE_TOOLS);
  if (opts.allowWeb || opts.allowBash) tools.push(...WEB_BASH_TOOLS);
  return tools;
}

/**
 * Returns the schema array shipped to the Anthropic API.
 */
function getToolSchemas(opts: ToolPhaseOpts = {}): ToolSchema[] {
  return getActiveTools(opts).map((t) => t.SCHEMA);
}

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
async function executeTool(name: string, input: unknown, ctx: unknown): Promise<ToolResult> {
  // Look up against the full registry — this dispatcher does NOT re-check
  // phase; the shipped schemas already did (see doc comment above).
  const allTools = getActiveTools({ allowWrite: true, allowWeb: true, allowBash: true });
  const tool = allTools.find((t) => t.SCHEMA.name === name);

  if (!tool) {
    return {
      content: [{
        type: "text",
        text: `Error: Unknown tool '${name}'. Available tools: ${
          allTools.map((t) => t.SCHEMA.name).join(", ")
        }`,
      }],
      isError: true,
    };
  }

  try {
    return await tool.execute(input || {}, ctx);
  } catch (e) {
    // Last-resort guard. A throwing tool would otherwise crash the loop.
    console.error(`[gryphon/sdk] Tool '${name}' threw:`, e);
    return {
      content: [{
        type: "text",
        text: `Error executing ${name}: ${(e as Error).message || String(e)}`,
      }],
      isError: true,
    };
  }
}

export { getActiveTools, getToolSchemas, executeTool };