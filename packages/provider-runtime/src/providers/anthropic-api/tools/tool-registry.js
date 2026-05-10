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

const Read = require("./read");
const Glob = require("./glob");
const Grep = require("./grep");
const Write = require("./write");
const Edit = require("./edit");
const WebFetch = require("./web-fetch");
const WebSearch = require("./web-search");
const Bash = require("./bash");

// Tool sets, grouped by phase. Each phase gates additional capabilities
// in the tool-loop so we can experiment with subsets if needed.
const READ_ONLY_TOOLS = [Read, Glob, Grep];
const WRITE_TOOLS = [Write, Edit];
const WEB_BASH_TOOLS = [WebFetch, WebSearch, Bash];

/**
 * Returns the active tool set based on which phases are enabled.
 * @param {object} opts — { allowWrite, allowWeb, allowBash }
 * @returns {Array<{SCHEMA, execute}>}
 */
function getActiveTools(opts = {}) {
  const tools = [...READ_ONLY_TOOLS];
  if (opts.allowWrite) tools.push(...WRITE_TOOLS);
  if (opts.allowWeb || opts.allowBash) tools.push(...WEB_BASH_TOOLS);
  return tools;
}

/**
 * Returns the schema array shipped to the Anthropic API.
 */
function getToolSchemas(opts = {}) {
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
async function executeTool(name, input, ctx) {
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
        text: `Error executing ${name}: ${e.message || String(e)}`,
      }],
      isError: true,
    };
  }
}

module.exports = { getActiveTools, getToolSchemas, executeTool };
