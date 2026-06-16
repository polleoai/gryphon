// packages/provider-runtime/tests/passive-live.test.ts
// Opt-in END-TO-END test: real `claude` subprocess + real MCP shim + real bridge,
// driven through the public createPassiveSession. Skipped unless
// RUN_LIVE_PASSIVE_TESTS=1 (it spawns claude and makes a billed API/subscription call).
//
//   RUN_LIVE_PASSIVE_TESTS=1 node --import tsx --test tests/passive-live.test.ts
const test = require("node:test");
const assert = require("node:assert/strict");
const { createPassiveSession } = require("../src/passive/index");

const LIVE = !!process.env.RUN_LIVE_PASSIVE_TESTS;

test("live: tool_use -> tool_result -> continuation round-trip", { skip: !LIVE ? "set RUN_LIVE_PASSIVE_TESTS=1 to run" : false }, async () => {
  const session = await createPassiveSession({
    kind: "claude-code",
    cwd: require("os").tmpdir(),
    model: process.env.SPIKE_MODEL || "claude-haiku-4-5",
    systemPrompt: "You are a backend. When asked, call the `echo` tool exactly once with {\"msg\":\"hi\"}, then in one short sentence report what it returned. Do not call any other tool.",
    declaredTools: [
      { name: "echo", description: "Echo back the given message.", input_schema: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] } },
    ],
  });

  try {
    const first = await session.send({ messages: [{ role: "user", content: "Call the echo tool now." }] });
    assert.equal(first.stop_reason, "tool_use", "claude should call the declared tool");
    const toolUse = first.content.find((b: any) => b.type === "tool_use");
    assert.ok(toolUse, "a tool_use block should be present");
    assert.equal(toolUse.name, "echo", "surfaced name is the BARE declared name, not namespaced");
    assert.ok(toolUse.id, "tool_use carries claude's id for correlation");

    // The caller executes the tool and feeds the result back.
    const second = await session.send({ messages: [
      { role: "user", content: "Call the echo tool now." },
      { role: "assistant", content: first.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: toolUse.id, content: "echoed: " + JSON.stringify(toolUse.input) }] },
    ] });
    assert.equal(second.stop_reason, "end_turn", "claude should finish after the tool_result");
    const text = second.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ");
    assert.ok(text.length > 0, "claude should produce a closing text turn");
    assert.ok(typeof second.total_cost_usd === "number");
    assert.ok(session.sessionId, "sessionId is set after the first send");
  } finally {
    await session.close();
  }
});
