// packages/provider-runtime/tests/passive-stream-parser.test.ts
const test = require("node:test");
const assert = require("node:assert/strict");
const { PassiveStreamParser } = require("../src/passive/stream-parser");

test("captures sessionId + model from system/init", () => {
  const p = new PassiveStreamParser();
  p.push({ type: "system", subtype: "init", session_id: "sess-1", model: "claude-sonnet-4-6" });
  assert.equal(p.sessionId, "sess-1");
  assert.equal(p.resolvedModel, "claude-sonnet-4-6");
});

test("text-only turn yields a single text block + end_turn", () => {
  const p = new PassiveStreamParser();
  p.push({ type: "system", subtype: "init", session_id: "s" });
  p.push({ type: "assistant", message: { content: [{ type: "text", text: "hello" }],
    usage: { input_tokens: 10, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } });
  const done = p.push({ type: "result", subtype: "success", stop_reason: "end_turn", total_cost_usd: 0.01, session_id: "s",
    usage: { input_tokens: 10, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } });
  assert.ok(done);
  assert.deepEqual(done.content, [{ type: "text", text: "hello" }]);
  assert.equal(done.stop_reason, "end_turn");
  assert.equal(done.total_cost_usd, 0.01);
  assert.equal(done.usage.input_tokens, 10);
  assert.equal(done.sessionId, "s");
});

test("tool_use block is preserved verbatim (id/name/input kept)", () => {
  const p = new PassiveStreamParser();
  p.push({ type: "system", subtype: "init", session_id: "s" });
  p.push({ type: "assistant", message: { content: [
    { type: "text", text: "I'll write the file" },
    { type: "tool_use", id: "toolu_1", name: "write_file", input: { path: "a.md", body: "x" } },
  ] } });
  const done = p.push({ type: "result", subtype: "success", stop_reason: "tool_use", total_cost_usd: 0.02, session_id: "s",
    usage: { input_tokens: 5, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } });
  assert.equal(done.content.length, 2);
  assert.deepEqual(done.content[1], { type: "tool_use", id: "toolu_1", name: "write_file", input: { path: "a.md", body: "x" } });
  assert.equal(done.stop_reason, "tool_use");
});

test("returns null until result arrives", () => {
  const p = new PassiveStreamParser();
  assert.equal(p.push({ type: "system", subtype: "init", session_id: "s" }), null);
  assert.equal(p.push({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } } }), null);
});

test("missing usage fields default to 0", () => {
  const p = new PassiveStreamParser();
  p.push({ type: "system", subtype: "init", session_id: "s" });
  const done = p.push({ type: "result", subtype: "success", stop_reason: "end_turn", session_id: "s" });
  assert.deepEqual(done.usage, { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
  assert.equal(done.total_cost_usd, 0);
});

test("unknown stop_reason falls back to end_turn", () => {
  const p = new PassiveStreamParser();
  p.push({ type: "system", subtype: "init", session_id: "s" });
  const done = p.push({ type: "result", subtype: "success", stop_reason: "weird", session_id: "s" });
  assert.equal(done.stop_reason, "end_turn");
});

test("flags error results (is_error / error subtype / api_error_status) via _resultError", () => {
  const p = new PassiveStreamParser();
  p.push({ type: "system", subtype: "init", session_id: "s" });
  const okDone = (() => { const q = new PassiveStreamParser(); return q.push({ type: "result", subtype: "success", stop_reason: "end_turn", session_id: "s" }); })();
  assert.equal(okDone._resultError, null);
  const errDone = p.push({ type: "result", subtype: "error_during_execution", is_error: true, session_id: "s", api_error_status: { type: "overloaded_error" } });
  assert.ok(errDone._resultError, "error result should set _resultError");
  assert.match(errDone._resultError, /error_during_execution/);
});

test("accumulates multiple assistant messages in one turn", () => {
  const p = new PassiveStreamParser();
  p.push({ type: "system", subtype: "init", session_id: "s" });
  p.push({ type: "assistant", message: { content: [{ type: "text", text: "one" }] } });
  p.push({ type: "assistant", message: { content: [{ type: "text", text: "two" }] } });
  const done = p.push({ type: "result", subtype: "success", stop_reason: "end_turn", session_id: "s" });
  assert.deepEqual(done.content, [{ type: "text", text: "one" }, { type: "text", text: "two" }]);
});
