// packages/provider-runtime/tests/passive-tool-roundtrip.test.ts
// Phase B: tool_use parking + tool_result continuation, driven by a fake claude
// (_spawnOverride) and a fake bridge (_bridgeOverride) — deterministic, no socket.
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createPassiveSession } = require("../src/passive/index");

function makeFakeChild() {
  const child: any = new EventEmitter();
  child.pid = 4243;
  child.exitCode = null; child.signalCode = null;
  child._writes = [];
  child.stdin = { write: (s: string) => { child._writes.push(s); return true; }, end() {} };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = (sig: any) => { child.killed = true; return true; };
  child.emitLine = (obj: any) => child.stdout.emit("data", Buffer.from(JSON.stringify(obj) + "\n"));
  return child;
}

function makeFakeBridge() {
  return {
    socketPath: "/tmp/fake.sock",
    _cb: null as any,
    _errCb: null as any,
    resolved: [] as any[],
    closed: false,
    _deliver: true,
    onInvoke(cb: any) { this._cb = cb; },
    onTransportError(cb: any) { this._errCb = cb; },
    invoke(inv: any) { this._cb && this._cb(inv); },          // test trigger
    transportDown(err: any) { this._errCb && this._errCb(err); }, // test trigger
    resolve(jsonrpcId: any, r: any) { this.resolved.push([jsonrpcId, r]); return this._deliver; },
    async close() { this.closed = true; },
  };
}

const echoTool = { name: "echo", description: "echo it", input_schema: { type: "object", properties: { msg: { type: "string" } } } };

function setup() {
  const child = makeFakeChild();
  const bridge = makeFakeBridge();
  const cfg = { kind: "claude-code", cwd: "/tmp/w", model: "claude-sonnet-4-6", declaredTools: [echoTool],
    _spawnOverride: () => child, _bridgeOverride: bridge };
  return { child, bridge, cfg };
}

test("send_returns_tool_use_block_when_model_calls_declared_tool", async () => {
  const { child, bridge, cfg } = setup();
  const session = await createPassiveSession(cfg);
  const p = session.send({ messages: [{ role: "user", content: "call echo" }] });
  child.emitLine({ type: "system", subtype: "init", session_id: "sX" });
  // claude emits the (namespaced) declared tool_use on stdout...
  child.emitLine({ type: "assistant", message: { content: [
    { type: "text", text: "calling echo" },
    { type: "tool_use", id: "toolu_1", name: "mcp__gryphon-passive__echo", input: { msg: "hi" } },
  ], usage: { input_tokens: 7, output_tokens: 4 } } });
  // ...and the shim parks the matching MCP call via the bridge.
  bridge.invoke({ jsonrpcId: 7, name: "echo", input: { msg: "hi" } });
  const res = await p;
  assert.equal(res.stop_reason, "tool_use");
  // text preserved; tool_use surfaced with the BARE name + claude's toolu id.
  assert.deepEqual(res.content[0], { type: "text", text: "calling echo" });
  assert.deepEqual(res.content[1], { type: "tool_use", id: "toolu_1", name: "echo", input: { msg: "hi" } });
  assert.equal(session.sessionId, "sX");
});

test("followup_send_with_tool_result_continues_session", async () => {
  const { child, bridge, cfg } = setup();
  const session = await createPassiveSession(cfg);
  const p1 = session.send({ messages: [{ role: "user", content: "call echo" }] });
  child.emitLine({ type: "system", subtype: "init", session_id: "sY" });
  child.emitLine({ type: "assistant", message: { content: [
    { type: "tool_use", id: "toolu_9", name: "mcp__gryphon-passive__echo", input: { msg: "hi" } },
  ] } });
  bridge.invoke({ jsonrpcId: 42, name: "echo", input: { msg: "hi" } });
  await p1;

  // caller executes the tool and feeds the result back
  const p2 = session.send({ messages: [
    { role: "user", content: "call echo" },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_9", name: "echo", input: { msg: "hi" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_9", content: "PONG" }] },
  ] });
  // bridge must have been told to resolve the parked call (correlated to jsonrpcId 42)
  assert.deepEqual(bridge.resolved[0], [42, { content: "PONG", is_error: false }]);
  // no new stdin user frame was written for the tool_result turn
  assert.equal(child._writes.length, 1, "only the first send writes a stdin user frame");
  // claude continues to end_turn
  child.emitLine({ type: "assistant", message: { content: [{ type: "text", text: "done: hi" }] } });
  child.emitLine({ type: "result", subtype: "success", stop_reason: "end_turn", total_cost_usd: 0.02, session_id: "sY" });
  const res2 = await p2;
  assert.equal(res2.stop_reason, "end_turn");
  assert.equal(res2.content[0].text, "done: hi");
  assert.equal(res2.total_cost_usd, 0.02);
  assert.equal(session.sessionId, "sY");
});

test("session_id_persists_across_sends", async () => {
  const { child, bridge, cfg } = setup();
  const session = await createPassiveSession(cfg);
  const p1 = session.send({ messages: [{ role: "user", content: "hi" }] });
  child.emitLine({ type: "system", subtype: "init", session_id: "persist-1" });
  child.emitLine({ type: "assistant", message: { content: [{ type: "text", text: "a" }] } });
  child.emitLine({ type: "result", subtype: "success", stop_reason: "end_turn", session_id: "persist-1" });
  await p1;
  assert.equal(session.sessionId, "persist-1");
});

test("close also closes the bridge", async () => {
  const { bridge, cfg } = setup();
  const session = await createPassiveSession(cfg);
  await session.close();
  assert.equal(bridge.closed, true);
});

test("parallel_tool_use_blocks_in_one_turn", async () => {
  const child = makeFakeChild();
  const bridge = makeFakeBridge();
  const writeTool = { name: "write_file", description: "w", input_schema: { type: "object" } };
  const session = await createPassiveSession({ kind: "claude-code", cwd: "/tmp/w", model: "m",
    declaredTools: [echoTool, writeTool], _spawnOverride: () => child, _bridgeOverride: bridge });
  const p = session.send({ messages: [{ role: "user", content: "do both" }] });
  child.emitLine({ type: "system", subtype: "init", session_id: "sP" });
  // claude emits TWO declared tool_use blocks in one assistant message
  child.emitLine({ type: "assistant", message: { content: [
    { type: "tool_use", id: "toolu_a", name: "mcp__gryphon-passive__echo", input: { msg: "x" } },
    { type: "tool_use", id: "toolu_b", name: "mcp__gryphon-passive__write_file", input: { path: "f" } },
  ] } });
  // only one parked so far -> must NOT settle yet
  bridge.invoke({ jsonrpcId: 1, name: "echo", input: { msg: "x" } });
  let settled = false; p.then(() => { settled = true; });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(settled, false, "should wait for ALL parallel calls to park");
  // second parks -> now settle with both blocks
  bridge.invoke({ jsonrpcId: 2, name: "write_file", input: { path: "f" } });
  const res = await p;
  assert.equal(res.stop_reason, "tool_use");
  assert.equal(res.content.length, 2);
  const ids = res.content.map((b: any) => b.id).sort();
  assert.deepEqual(ids, ["toolu_a", "toolu_b"]);

  // follow-up: both tool_results must resolve both parked calls (together)
  session.send({ messages: [
    { role: "user", content: [
      { type: "tool_result", tool_use_id: "toolu_a", content: "ra" },
      { type: "tool_result", tool_use_id: "toolu_b", content: "rb" },
    ] },
  ] });
  const byId = Object.fromEntries(bridge.resolved.map((x: any) => [x[0], x[1].content]));
  assert.equal(byId[1], "ra");
  assert.equal(byId[2], "rb");
});

test("disallowed_tool_invocation_returns_error_tool_result", async () => {
  const { child, bridge, cfg } = setup();
  const session = await createPassiveSession(cfg);
  const p1 = session.send({ messages: [{ role: "user", content: "call echo" }] });
  child.emitLine({ type: "system", subtype: "init", session_id: "sE" });
  child.emitLine({ type: "assistant", message: { content: [
    { type: "tool_use", id: "toolu_e", name: "mcp__gryphon-passive__echo", input: {} },
  ] } });
  bridge.invoke({ jsonrpcId: 3, name: "echo", input: {} });
  await p1;
  // caller denies the tool — is_error propagates to the bridge.resolve call
  session.send({ messages: [
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_e", content: "denied", is_error: true }] },
  ] });
  assert.deepEqual(bridge.resolved[0], [3, { content: "denied", is_error: true }]);
});

test("follow-up send without tool_result while calls are parked is rejected (no hang)", async () => {
  const { child, bridge, cfg } = setup();
  const session = await createPassiveSession(cfg);
  const p1 = session.send({ messages: [{ role: "user", content: "call echo" }] });
  child.emitLine({ type: "system", subtype: "init", session_id: "sH" });
  child.emitLine({ type: "assistant", message: { content: [
    { type: "tool_use", id: "toolu_h", name: "mcp__gryphon-passive__echo", input: {} },
  ] } });
  bridge.invoke({ jsonrpcId: 11, name: "echo", input: {} });
  await p1;
  await assert.rejects(
    () => session.send({ messages: [{ role: "user", content: "never mind, hi" }] }),
    /awaiting results/,
  );
});

test("concurrent send() before the first resolves is rejected (no orphan)", async () => {
  const { child, cfg } = setup();
  const session = await createPassiveSession(cfg);
  const p1 = session.send({ messages: [{ role: "user", content: "one" }] });
  await assert.rejects(() => session.send({ messages: [{ role: "user", content: "two" }] }), /still in flight/);
  // resolve the first so the test exits clean
  child.emitLine({ type: "system", subtype: "init", session_id: "sC" });
  child.emitLine({ type: "result", subtype: "success", stop_reason: "end_turn", session_id: "sC" });
  await p1;
});

test("error result event rejects instead of faking an empty success (C1)", async () => {
  const { child, cfg } = setup();
  const session = await createPassiveSession(cfg);
  const p = session.send({ messages: [{ role: "user", content: "hi" }] });
  child.emitLine({ type: "system", subtype: "init", session_id: "sErr" });
  child.emitLine({ type: "result", subtype: "error_during_execution", is_error: true, session_id: "sErr", api_error_status: { type: "overloaded_error" } });
  await assert.rejects(() => p, /error result/);
});

test("MCP transport death rejects the in-flight send (C2/H3)", async () => {
  const { bridge, cfg } = setup();
  const session = await createPassiveSession(cfg);
  const p = session.send({ messages: [{ role: "user", content: "call echo" }] });
  bridge.transportDown(new Error("socket closed"));
  await assert.rejects(() => p, /socket closed|transport/);
});

test("tool_result for an unknown tool_use_id is rejected, not dropped (H1-sf)", async () => {
  const { child, bridge, cfg } = setup();
  const session = await createPassiveSession(cfg);
  const p1 = session.send({ messages: [{ role: "user", content: "call echo" }] });
  child.emitLine({ type: "system", subtype: "init", session_id: "sU" });
  child.emitLine({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_real", name: "mcp__gryphon-passive__echo", input: {} }] } });
  bridge.invoke({ jsonrpcId: 1, name: "echo", input: {} });
  await p1;
  await assert.rejects(
    () => session.send({ messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_WRONG", content: "x" }] }] }),
    /unknown tool_use_id/,
  );
});

test("undeliverable tool_result (bridge gone) rejects, not hangs (C3)", async () => {
  const { child, bridge, cfg } = setup();
  const session = await createPassiveSession(cfg);
  const p1 = session.send({ messages: [{ role: "user", content: "call echo" }] });
  child.emitLine({ type: "system", subtype: "init", session_id: "sD" });
  child.emitLine({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_d", name: "mcp__gryphon-passive__echo", input: {} }] } });
  bridge.invoke({ jsonrpcId: 2, name: "echo", input: {} });
  await p1;
  bridge._deliver = false; // simulate dead shim socket
  await assert.rejects(
    () => session.send({ messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_d", content: "x" }] }] }),
    /could not deliver/,
  );
});

test("multi-round: tool_use -> result -> tool_use again re-parks correctly (CR-M2)", async () => {
  const { child, bridge, cfg } = setup();
  const session = await createPassiveSession(cfg);
  // round 1
  const p1 = session.send({ messages: [{ role: "user", content: "go" }] });
  child.emitLine({ type: "system", subtype: "init", session_id: "sM" });
  child.emitLine({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "mcp__gryphon-passive__echo", input: { n: 1 } }] } });
  bridge.invoke({ jsonrpcId: 100, name: "echo", input: { n: 1 } });
  const r1 = await p1;
  assert.equal(r1.content[0].id, "t1");
  // round 2: feed result, claude calls the tool AGAIN (re-park), not end_turn
  const p2 = session.send({ messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "r1" }] }] });
  assert.deepEqual(bridge.resolved[0], [100, { content: "r1", is_error: false }]);
  child.emitLine({ type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "mcp__gryphon-passive__echo", input: { n: 2 } }] } });
  bridge.invoke({ jsonrpcId: 101, name: "echo", input: { n: 2 } });
  const r2 = await p2;
  assert.equal(r2.stop_reason, "tool_use");
  assert.equal(r2.content[0].id, "t2");
  // round 3: final tool_result -> end_turn
  const p3 = session.send({ messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "r2" }] }] });
  assert.deepEqual(bridge.resolved[1], [101, { content: "r2", is_error: false }]);
  child.emitLine({ type: "assistant", message: { content: [{ type: "text", text: "all done" }] } });
  child.emitLine({ type: "result", subtype: "success", stop_reason: "end_turn", session_id: "sM" });
  const r3 = await p3;
  assert.equal(r3.stop_reason, "end_turn");
  assert.equal(r3.content[0].text, "all done");
});

test("partial answer of parallel parked calls is rejected (no half-hang)", async () => {
  const child = makeFakeChild();
  const bridge = makeFakeBridge();
  const writeTool = { name: "write_file", description: "w", input_schema: { type: "object" } };
  const session = await createPassiveSession({ kind: "claude-code", cwd: "/tmp/w", model: "m",
    declaredTools: [echoTool, writeTool], _spawnOverride: () => child, _bridgeOverride: bridge });
  const p = session.send({ messages: [{ role: "user", content: "both" }] });
  child.emitLine({ type: "system", subtype: "init", session_id: "sPP" });
  child.emitLine({ type: "assistant", message: { content: [
    { type: "tool_use", id: "ta", name: "mcp__gryphon-passive__echo", input: {} },
    { type: "tool_use", id: "tb", name: "mcp__gryphon-passive__write_file", input: {} },
  ] } });
  bridge.invoke({ jsonrpcId: 1, name: "echo", input: {} });
  bridge.invoke({ jsonrpcId: 2, name: "write_file", input: {} });
  await p;
  await assert.rejects(
    () => session.send({ messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "ta", content: "x" }] }] }),
    /all parked tool calls must be answered/,
  );
});

test("ToolSearch (non-declared) tool_use is filtered from surfaced content", async () => {
  const { child, bridge, cfg } = setup();
  const session = await createPassiveSession(cfg);
  const p = session.send({ messages: [{ role: "user", content: "call echo" }] });
  child.emitLine({ type: "system", subtype: "init", session_id: "sF" });
  // claude's internal discovery call must NOT surface to the caller.
  child.emitLine({ type: "assistant", message: { content: [
    { type: "tool_use", id: "ts_1", name: "ToolSearch", input: { query: "x" } },
  ] } });
  child.emitLine({ type: "assistant", message: { content: [
    { type: "tool_use", id: "toolu_2", name: "mcp__gryphon-passive__echo", input: { msg: "yo" } },
  ] } });
  bridge.invoke({ jsonrpcId: 5, name: "echo", input: { msg: "yo" } });
  const res = await p;
  assert.equal(res.content.length, 1);
  assert.equal(res.content[0].name, "echo");
});
