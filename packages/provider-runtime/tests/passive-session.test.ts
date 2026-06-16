// packages/provider-runtime/tests/passive-session.test.ts
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createPassiveSession } = require("../src/passive/index");

// Fake child: records stdin writes, lets the test emit stdout lines.
function makeFakeChild() {
  const child: any = new EventEmitter();
  child.pid = 4242;
  child.exitCode = null;
  child.signalCode = null;
  child.stdin = { write: (s: string) => { child._writes.push(s); return true; }, end() {} };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = (sig: any) => { child.killed = true; child._killSig = sig; return true; };
  child._writes = [];
  child.emitLine = (obj: any) => child.stdout.emit("data", Buffer.from(JSON.stringify(obj) + "\n"));
  return child;
}

const baseCfg = { kind: "claude-code", cwd: "/tmp/work", model: "claude-sonnet-4-6", declaredTools: [] };

test("throws on missing cwd", async () => {
  await assert.rejects(() => createPassiveSession({ ...baseCfg, cwd: "" }), /cwd is required/);
});

test("throws on unknown kind", async () => {
  await assert.rejects(() => createPassiveSession({ ...baseCfg, kind: "codex-cli" }), /unsupported kind/);
});

test("throws on invalid declaredTools schema", async () => {
  await assert.rejects(
    () => createPassiveSession({ ...baseCfg, declaredTools: [{ name: "x", description: "d" }] }),
    /input_schema/,
  );
});

test("send returns text content when no tool_use", async () => {
  const child = makeFakeChild();
  const session = await createPassiveSession({ ...baseCfg, _spawnOverride: () => child });
  const p = session.send({ messages: [{ role: "user", content: "hi" }] });
  child.emitLine({ type: "system", subtype: "init", session_id: "sess-9", model: "claude-sonnet-4-6" });
  child.emitLine({ type: "assistant", message: { content: [{ type: "text", text: "hello there" }] } });
  child.emitLine({ type: "result", subtype: "success", stop_reason: "end_turn", total_cost_usd: 0.005, session_id: "sess-9",
    usage: { input_tokens: 4, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } });
  const res = await p;
  assert.deepEqual(res.content, [{ type: "text", text: "hello there" }]);
  assert.equal(res.stop_reason, "end_turn");
  assert.equal(res.sessionId, "sess-9");
  assert.equal(res.total_cost_usd, 0.005);
  assert.equal(session.sessionId, "sess-9");
  const frame = JSON.parse(child._writes[0]);
  assert.equal(frame.type, "user");
  assert.equal(frame.message.content, "hi");
});

test("two sends reuse the same process and persist sessionId", async () => {
  const child = makeFakeChild();
  const session = await createPassiveSession({ ...baseCfg, _spawnOverride: () => child });
  const p1 = session.send({ messages: [{ role: "user", content: "first" }] });
  child.emitLine({ type: "system", subtype: "init", session_id: "sess-X" });
  child.emitLine({ type: "assistant", message: { content: [{ type: "text", text: "a" }] } });
  child.emitLine({ type: "result", subtype: "success", stop_reason: "end_turn", session_id: "sess-X" });
  await p1;
  const p2 = session.send({ messages: [{ role: "user", content: "second" }] });
  child.emitLine({ type: "assistant", message: { content: [{ type: "text", text: "b" }] } });
  child.emitLine({ type: "result", subtype: "success", stop_reason: "end_turn", session_id: "sess-X" });
  const res2 = await p2;
  assert.equal(res2.content[0].text, "b");
  assert.equal(session.sessionId, "sess-X");
  assert.equal(child._writes.length, 2); // one user frame per send, same process
});

test("close kills the subprocess", async () => {
  const child = makeFakeChild();
  const session = await createPassiveSession({ ...baseCfg, _spawnOverride: () => child });
  // force a spawn by issuing a send (then close)
  session.send({ messages: [{ role: "user", content: "hi" }] }).catch(() => {});
  await session.close();
  assert.equal(child.killed, true);
});

test("pre-aborted signal rejects send immediately", async () => {
  const child = makeFakeChild();
  const session = await createPassiveSession({ ...baseCfg, _spawnOverride: () => child });
  const ac = new AbortController(); ac.abort();
  await assert.rejects(() => session.send({ messages: [{ role: "user", content: "hi" }], signal: ac.signal }), /Aborted/);
});

test("subprocess exit before result rejects the pending send", async () => {
  const child = makeFakeChild();
  const session = await createPassiveSession({ ...baseCfg, _spawnOverride: () => child });
  const p = session.send({ messages: [{ role: "user", content: "hi" }] });
  child.stderr.emit("data", Buffer.from("boom: bad flag\n"));
  child.emit("close", 1);
  await assert.rejects(() => p, /exited before producing a result/);
});
