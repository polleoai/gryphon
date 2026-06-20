#!/usr/bin/env node
// Passive MCP shim — stdio JSON-RPC MCP server spawned by claude as a grandchild.
// It exposes the caller's declared tools but NEVER executes them: each tools/call
// is forwarded to the gryphon-side bridge over a unix socket and PARKED until the
// bridge sends back a result (which is the caller-supplied tool_result). This is
// what makes claude a passive backend — gryphon, not claude, owns tool execution.
//
// Standalone CommonJS so `node server.cjs` runs it in src/ AND dist/ (it is
// copied to dist/passive/mcp-shim/ by the build). See design spec §6 + §12.
//
// stdout is the JSON-RPC channel to claude; all logs go to stderr.

const net = require("net");

const SOCKET = process.env.GRYPHON_PASSIVE_SOCKET;
let TOOLS = [];
try { TOOLS = JSON.parse(process.env.GRYPHON_PASSIVE_TOOLS || "[]"); } catch { TOOLS = []; }

function log(...a) { try { process.stderr.write("[gryphon-passive-shim] " + a.join(" ") + "\n"); } catch {} }
function sendRpc(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }

// ── bridge socket ──────────────────────────────────────────────────────────
const parked = new Map(); // jsonrpcId -> true (awaiting bridge result)
let bridge = null;
let bridgeBuf = "";

function connectBridge() {
  if (!SOCKET) { log("no GRYPHON_PASSIVE_SOCKET set; tools/call will error"); return; }
  bridge = net.connect(SOCKET);
  bridge.setEncoding("utf8");
  bridge.on("connect", () => log("connected to bridge", SOCKET));
  bridge.on("data", (chunk) => {
    bridgeBuf += chunk;
    const lines = bridgeBuf.split("\n");
    bridgeBuf = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.kind === "result" && parked.has(msg.jsonrpcId)) {
        parked.delete(msg.jsonrpcId);
        sendRpc({ jsonrpc: "2.0", id: msg.jsonrpcId, result: toMcpResult(msg.content, msg.is_error) });
      }
    }
  });
  bridge.on("error", (e) => log("bridge socket error:", e && e.message));
}

// Translate a caller tool_result `content` (string | array of content blocks)
// into the MCP tools/call result shape.
function toMcpResult(content, isError) {
  let items;
  if (typeof content === "string") {
    items = [{ type: "text", text: content }];
  } else if (Array.isArray(content)) {
    items = content.map((b) => {
      if (b && b.type === "text" && typeof b.text === "string") return { type: "text", text: b.text };
      return { type: "text", text: typeof b === "string" ? b : JSON.stringify(b) };
    });
  } else {
    items = [{ type: "text", text: content == null ? "" : JSON.stringify(content) }];
  }
  return { content: items, isError: !!isError };
}

// ── MCP stdio JSON-RPC ───────────────────────────────────────────────────────
let stdinBuf = "";
process.stdin.on("data", (d) => {
  stdinBuf += d.toString();
  const lines = stdinBuf.split("\n");
  stdinBuf = lines.pop() || "";
  for (const line of lines) { if (line.trim()) handle(line); }
});

function handle(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;

  if (method === "initialize") {
    sendRpc({ jsonrpc: "2.0", id, result: {
      protocolVersion: (params && params.protocolVersion) || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "gryphon-passive", version: "1.0.0" },
    } });
    return;
  }
  if (method === "notifications/initialized") return; // notification, no reply

  if (method === "tools/list") {
    sendRpc({ jsonrpc: "2.0", id, result: { tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description || "",
      inputSchema: t.input_schema || { type: "object" },
    })) } });
    return;
  }

  if (method === "tools/call") {
    const name = params && params.name;
    const input = (params && params.arguments) || {};
    if (!bridge || bridge.destroyed) {
      sendRpc({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "passive bridge unavailable" }], isError: true } });
      return;
    }
    // PARK: forward to the bridge and withhold the reply until it resolves.
    parked.set(id, true);
    try {
      bridge.write(JSON.stringify({ kind: "invoke", jsonrpcId: id, name, input }) + "\n");
    } catch (e) {
      parked.delete(id);
      sendRpc({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "passive bridge write failed" }], isError: true } });
    }
    return;
  }

  // Unknown method — answer requests (with id) so claude isn't left hanging.
  if (id != null) sendRpc({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found: " + method } });
}

connectBridge();
log("ready, tools=" + TOOLS.map((t) => t && t.name).join(","));
