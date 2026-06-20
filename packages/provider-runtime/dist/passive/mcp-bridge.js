"use strict";
// packages/provider-runtime/src/passive/mcp-bridge.ts
// Gryphon-side end of the passive MCP shim. Opens a unix-domain socket (named
// pipe on Windows) that the shim (claude's grandchild) connects to. The shim
// forwards each parked tools/call as an {kind:"invoke", jsonrpcId, name, input}
// frame; the session resolves it later via resolve(jsonrpcId, {content,is_error}),
// which is pushed back to the shim to unblock the held-open JSON-RPC response.
//
// Newline-delimited JSON framing both directions. See design spec §6 + §12.
Object.defineProperty(exports, "__esModule", { value: true });
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");
const IS_WINDOWS = process.platform === "win32";
let _counter = 0;
function freshSocketPath() {
    _counter += 1;
    const base = `gryphon-passive-${process.pid}-${Date.now()}-${_counter}`;
    if (IS_WINDOWS)
        return `\\\\.\\pipe\\${base}`;
    return path.join(os.tmpdir(), `${base}.sock`);
}
function createBridge() {
    return new Promise((resolve, reject) => {
        const socketPath = freshSocketPath();
        let invokeCb = null;
        let errorCb = null;
        let shimSock = null;
        let buffer = "";
        let closing = false;
        const fireError = (err) => {
            if (closing || !errorCb)
                return;
            try {
                errorCb(err instanceof Error ? err : new Error(String(err)));
            }
            catch { /* never throw from a transport callback */ }
        };
        const server = net.createServer((sock) => {
            shimSock = sock;
            sock.setEncoding("utf8");
            sock.on("data", (chunk) => {
                buffer += chunk;
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";
                for (const line of lines) {
                    if (!line.trim())
                        continue;
                    let msg;
                    try {
                        msg = JSON.parse(line);
                    }
                    catch {
                        continue;
                    }
                    if (msg.kind === "invoke" && invokeCb) {
                        invokeCb({ jsonrpcId: msg.jsonrpcId, name: msg.name, input: msg.input });
                    }
                }
            });
            // Surface an unexpected transport death so the session can reject the
            // pending send() instead of hanging forever (silent-failure C2/C3/H3).
            sock.on("error", (e) => fireError(e));
            sock.on("close", (hadErr) => { if (!closing)
                fireError(new Error(`passive MCP transport closed unexpectedly${hadErr ? " (after error)" : ""}`)); });
        });
        server.on("error", reject);
        server.listen(socketPath, () => {
            resolve({
                socketPath,
                onInvoke(cb) { invokeCb = cb; },
                onTransportError(cb) { errorCb = cb; },
                // Returns false if the result could not be delivered (shim socket gone).
                resolve(jsonrpcId, result) {
                    if (!shimSock || shimSock.destroyed)
                        return false;
                    try {
                        shimSock.write(JSON.stringify({
                            kind: "result",
                            jsonrpcId,
                            content: result && result.content,
                            is_error: !!(result && result.is_error),
                        }) + "\n");
                        return true;
                    }
                    catch {
                        return false;
                    }
                },
                close() {
                    closing = true;
                    return new Promise((res) => {
                        try {
                            if (shimSock)
                                shimSock.destroy();
                        }
                        catch { /* ignore */ }
                        const done = () => {
                            // Unlink the POSIX socket node (Windows named pipes leave none).
                            if (!IS_WINDOWS) {
                                try {
                                    fs.rmSync(socketPath, { force: true });
                                }
                                catch { /* ignore */ }
                            }
                            res();
                        };
                        try {
                            server.close(done);
                        }
                        catch {
                            done();
                        }
                    });
                },
            });
        });
    });
}
module.exports = { createBridge };
