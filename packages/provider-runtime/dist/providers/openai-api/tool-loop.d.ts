/**
 * OpenAI tool-use loop driver.
 *
 * Mirror of anthropic-api/tool-loop.js but speaks OpenAI's tool-call shape:
 *
 *   1. Send messages (with tools[]) → SDK streams content deltas + tool-call deltas
 *   2. If finish_reason === "tool_calls", collect the tool_calls list
 *   3. Execute each tool locally → build tool-result messages (role: "tool")
 *   4. Append assistant turn (with tool_calls) + tool result messages to history
 *   5. Loop until finish_reason !== "tool_calls"
 *
 * Tool execution goes through Gryphon's existing executeTool() from
 * anthropic-api/tools/tool-registry, so the protected-pattern guardrails
 * (attack-detector PreToolUse classification, permission-gate prompts,
 * per-tool input scrubbing) fire identically regardless of which provider
 * triggered the call. This is the v1.2 security parity guarantee — Stage 4
 * re-validates against synthetic GPT outputs.
 *
 * History invariant (mirrors anthropic-api/tool-loop.js): `history` is
 * mutated IN PLACE so the caller's send() can roll back to a pre-turn
 * checkpoint on thrown error. Do not clone the array internally.
 */
export {};
