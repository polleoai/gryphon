"use strict";
// packages/provider-runtime/src/passive/mcp-bridge.ts
// Gryphon-side end of the passive MCP shim. Opens a unix-domain socket (named
// pipe on Windows) that the shim (claude's grandchild) connects to. The shim
// forwards each parked tools/call as an {kind:"invoke", jsonrpcId, name, input}
// frame; the session resolves it later via resolve(jsonrpcId, {content,is_error}),
// which is pushed back to the shim to unblock the held-open JSON-RPC response.
//
// Newline-delimited JSON framing both directions. See design spec §6 + §12.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.createBridge = createBridge;
const net = __importStar(require("net"));
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
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
