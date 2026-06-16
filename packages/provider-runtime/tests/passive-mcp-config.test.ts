// packages/provider-runtime/tests/passive-mcp-config.test.ts
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { buildMcpConfig, MCP_SERVER_NAME, namespacedToolName } = require("../src/passive/mcp-config-builder");

test("writes a strict single-server stdio config carrying socket + tools", () => {
  const tools = [{ name: "echo", description: "echo back", input_schema: { type: "object", properties: { msg: { type: "string" } } } }];
  const { json, jsonPath } = buildMcpConfig(tools, { shimEntry: "/abs/server.cjs", socketPath: "/tmp/p.sock" });
  const onDisk = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  assert.deepEqual(onDisk, json);
  const srv = json.mcpServers[MCP_SERVER_NAME];
  assert.equal(srv.command, "node");
  assert.deepEqual(srv.args, ["/abs/server.cjs"]);
  assert.equal(srv.env.GRYPHON_PASSIVE_SOCKET, "/tmp/p.sock");
  assert.deepEqual(JSON.parse(srv.env.GRYPHON_PASSIVE_TOOLS), tools);
  fs.unlinkSync(jsonPath);
});

test("namespacedToolName maps bare -> mcp__<server>__<name>", () => {
  assert.equal(namespacedToolName("echo"), "mcp__gryphon-passive__echo");
  assert.equal(MCP_SERVER_NAME, "gryphon-passive");
});
