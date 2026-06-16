// packages/provider-runtime/tests/passive-mcp-bridge.test.ts
// Bridge <-> shim talk over a real unix socket; no claude. Proves the shim
// parks a tools/call until the bridge resolves it, and speaks MCP stdio JSON-RPC.
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");
const { createBridge } = require("../src/passive/mcp-bridge");

const SHIM = path.join(__dirname, "..", "src", "passive", "mcp-shim", "server.cjs");

function startShim(socketPath: string, tools: any[]) {
  const child = spawn(process.execPath, [SHIM], {
    env: { ...process.env, GRYPHON_PASSIVE_SOCKET: socketPath, GRYPHON_PASSIVE_TOOLS: JSON.stringify(tools) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const rpc = (o: any) => child.stdin.write(JSON.stringify(o) + "\n");
  const seen: any[] = [];
  let buf = "";
  child.stdout.on("data", (d: any) => {
    buf += d.toString();
    const lines = buf.split("\n"); buf = lines.pop() || "";
    for (const line of lines) { if (line.trim()) { try { seen.push(JSON.parse(line)); } catch {} } }
  });
  const waitFor = (pred: any, ms = 4000) => new Promise<any>((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const hit = seen.find(pred);
      if (hit) { clearInterval(iv); resolve(hit); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error("timeout waiting for rpc reply")); }
    }, 15);
  });
  return { child, rpc, waitFor };
}

test("shim handshakes + lists declared tools (namespaced not required at list level)", async () => {
  const bridge = await createBridge();
  const tools = [{ name: "echo", description: "echo it", input_schema: { type: "object", properties: { msg: { type: "string" } } } }];
  const shim = startShim(bridge.socketPath, tools);
  shim.rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
  const initReply = await shim.waitFor((m: any) => m.id === 1);
  assert.ok(initReply.result && initReply.result.serverInfo);
  shim.rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const listReply = await shim.waitFor((m: any) => m.id === 2);
  assert.equal(listReply.result.tools[0].name, "echo");
  assert.ok(listReply.result.tools[0].inputSchema, "tools/list uses inputSchema (MCP shape)");
  shim.child.kill(); await bridge.close();
});

test("shim parks tools/call until the bridge resolves it", async () => {
  const bridge = await createBridge();
  const invokes: any[] = [];
  bridge.onInvoke((inv: any) => {
    invokes.push(inv);
    // resolve after a short delay to prove the call was genuinely parked
    setTimeout(() => bridge.resolve(inv.jsonrpcId, { content: "PONG:" + inv.input.msg, is_error: false }), 120);
  });
  const shim = startShim(bridge.socketPath, [{ name: "echo", description: "e", input_schema: { type: "object" } }]);
  shim.rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  await shim.waitFor((m: any) => m.id === 1);
  shim.rpc({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "echo", arguments: { msg: "hi" } } });
  const reply = await shim.waitFor((m: any) => m.id === 7);
  assert.equal(invokes.length, 1);
  assert.equal(invokes[0].jsonrpcId, 7);
  assert.equal(invokes[0].name, "echo");
  assert.deepEqual(invokes[0].input, { msg: "hi" });
  assert.ok(JSON.stringify(reply.result.content).includes("PONG:hi"));
  assert.ok(!reply.result.isError);
  shim.child.kill(); await bridge.close();
});

test("bridge.resolve with is_error marks the MCP result errored", async () => {
  const bridge = await createBridge();
  bridge.onInvoke((inv: any) => bridge.resolve(inv.jsonrpcId, { content: "denied", is_error: true }));
  const shim = startShim(bridge.socketPath, [{ name: "echo", description: "e", input_schema: { type: "object" } }]);
  shim.rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  await shim.waitFor((m: any) => m.id === 1);
  shim.rpc({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "echo", arguments: {} } });
  const reply = await shim.waitFor((m: any) => m.id === 9);
  assert.equal(reply.result.isError, true);
  shim.child.kill(); await bridge.close();
});
