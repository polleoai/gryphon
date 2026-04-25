/**
 * Permission IPC server (v0.6.0) — the Unix-domain socket the Gryphon
 * plugin runs so Claude Code hook scripts can call back into the
 * plugin while CC is mid-turn.
 *
 * Protocol
 * --------
 * Line-delimited JSON. Each client connection sends one or more
 * `{"req": "<name>", "id": "<uuid>", ...}` lines and receives one
 * `{"resp": "<name>"|"error", "id": "<uuid>", ...}` line per request.
 * The `id` round-trips so clients can pair requests with responses on
 * a shared connection (hook scripts open one connection per tool call,
 * but the protocol tolerates reuse).
 *
 * Security
 * --------
 * Unix sockets created with 0600 perms — filesystem permissions are the
 * whole auth story in v0.6. No tokens, no HMAC. A same-uid process could
 * connect; we accept that (any process on the machine running as the
 * user can already read the user's files, so this isn't a new trust
 * boundary).
 *
 * Path length note
 * ----------------
 * macOS limits Unix socket paths to 104 chars (Linux ~108). Obsidian
 * plugin paths can exceed that, especially in iCloud-synced vaults.
 * `defaultSocketPath()` sidesteps the problem by putting the socket in
 * `os.tmpdir()` which is short on every platform we support. The plugin
 * still stores the chosen path so `onunload()` can unlink it.
 *
 * Windows
 * -------
 * `isDesktopOnly: true` includes Windows. Node transparently maps
 * `net.createServer().listen(path)` to named pipes when `path` starts
 * with `\\.\pipe\`; the protocol we speak over the pipe is identical.
 * We skip chmod/unlink on Windows because named pipes have a different
 * lifecycle (auto-cleaned when the owning process exits).
 */

const net = require("net");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const IS_WINDOWS = process.platform === "win32";

// Round-12 F11: cap per-connection read buffer. The protocol is one line
// of JSON per request; a single classify request payload is tens of
// bytes. 1 MiB is far above any legitimate request yet small enough that
// a same-uid attacker can't OOM the renderer by streaming unbounded data
// with no newline.
const MAX_LINE_BYTES = 1 * 1024 * 1024;
// Round-12 F13: cap concurrent connections to bound FD usage. Each
// hook opens one connection per tool call; 32 is generous even for
// bursty sessions.
const MAX_CONCURRENT_SOCKETS = 32;
// Round-14 Q2: hard time-to-complete-request cap. A same-uid attacker
// can hold all 32 slots with slow-loris connections (1 byte every 200ms
// stays under MAX_LINE_BYTES and never sends \n) and starve all legit
// hook traffic indefinitely. A simple idle timeout resets on every byte
// received so slow-trickle defeats it; we use a hard total-lifetime
// cap from accept to completed-request. 15 seconds is far longer than
// any legitimate non-classify request on a local Unix socket (usual is
// sub-millisecond) while still force-closing any stale connection
// within a bounded window. Classify requests get extended to
// MODAL_REQUEST_LIFETIME_MS — they legitimately block on user input.
const REQUEST_LIFETIME_MS = 15 * 1000;
// Classify requests block on user input via the permission modal, so
// they can legitimately take much longer than a normal IPC call. Keep
// this comfortably under the hook's own deadline (pretool.js's
// IPC_TIMEOUT_MS = 270s; OVERALL_DEADLINE_MS = 285s) so the server
// drops the connection before the hook's own timeout fires. 300s
// would exceed pretool's 285s deadline and let the hook land a timeout-
// deny that contradicts an eventual modal-allow response. 240s gives
// 45s of headroom at each end.
const MODAL_REQUEST_LIFETIME_MS = 240 * 1000;

class PermissionIPCServer {
  constructor() {
    this._server = null;
    this._socketPath = null;
    this._handlers = new Map();
    this._activeSockets = new Set();
    // Concurrency guard — if create() is called while another create is
    // in flight (e.g. during plugin load + a racing ensureIpcListening
    // from a chat-send), the second call waits for the first rather
    // than both trying to bind the same pipe and leaking a server.
    this._creatingPromise = null;
  }

  /**
   * Register a handler for a request type. Handler receives the parsed
   * request object and returns (or resolves to) a response object. The
   * server auto-appends a `resp` field (if absent) and echoes back the
   * `id` so the client can correlate.
   */
  on(reqType, handler) {
    if (typeof reqType !== "string" || reqType.length === 0) {
      throw new TypeError("on(reqType, handler): reqType must be a non-empty string");
    }
    if (typeof handler !== "function") {
      throw new TypeError("on(reqType, handler): handler must be a function");
    }
    this._handlers.set(reqType, handler);
  }

  /**
   * Bind the socket and start accepting connections. Resolves when the
   * server is listening. Rejects if bind fails.
   *
   * Unlinks any stale socket file from a prior crashed load before
   * binding. On Unix the socket file is chmod'd to 0600 after listen;
   * we also set the process umask during listen as belt-and-suspenders
   * (the initial file perms depend on umask, and different environments
   * have different defaults).
   */
  async create(socketPath) {
    // Dedupe concurrent creates. If one create() is already running,
    // return its promise rather than racing it. The second caller
    // gets the same success/failure as the first; no double-bind.
    if (this._creatingPromise) return this._creatingPromise;
    if (this._server) {
      throw new Error("PermissionIPCServer: already created");
    }
    if (typeof socketPath !== "string" || socketPath.length === 0) {
      throw new TypeError("create(socketPath): socketPath must be a non-empty string");
    }
    this._creatingPromise = this._doCreate(socketPath)
      .finally(() => { this._creatingPromise = null; });
    return this._creatingPromise;
  }

  async _doCreate(socketPath) {

    if (!IS_WINDOWS) {
      if (fs.existsSync(socketPath)) {
        fs.unlinkSync(socketPath);
      }
      const dir = path.dirname(socketPath);
      if (dir && dir !== "." && !fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      // Crash-orphaned socket files from other sessions are swept by
      // the centralised `tmpfile-sweeper` at plugin onload. We don't
      // duplicate that sweep here — this branch only unlinks a
      // file at our exact chosen path (race-rare but defensive).
    }

    this._socketPath = socketPath;

    await new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this._onConnection(socket));

      const onError = (err) => {
        server.removeListener("error", onError);
        this._socketPath = null;
        reject(err);
      };
      server.on("error", onError);

      const finishListen = () => {
        if (!IS_WINDOWS) {
          // The security model treats socket perms as load-bearing
          // (see file header). umask(0o077) around listen() gives
          // 0600 on every Unix we know of; chmod is belt-and-braces.
          // If chmod fails, verify perms are actually safe before
          // proceeding — a world-readable socket defeats the auth-
          // by-filesystem-perms story entirely.
          let chmodOk = true;
          try { fs.chmodSync(socketPath, 0o600); }
          catch (e) {
            chmodOk = false;
            try { console.warn("[gryphon/ipc] chmod failed:", e && e.message); } catch (_) {}
          }
          if (!chmodOk) {
            try {
              const st = fs.statSync(socketPath);
              const worldBits = st.mode & 0o077;
              if (worldBits !== 0) {
                // Socket is world-accessible and we can't fix it —
                // fail the create so the caller can decide (and
                // so `isListening()` doesn't later claim we're safe).
                server.removeAllListeners("error");
                server.close(() => {});
                try { fs.unlinkSync(socketPath); } catch (_) {}
                this._socketPath = null;
                reject(new Error(
                  `IPC socket perms too permissive (mode ${st.mode.toString(8)}) ` +
                  `and chmod failed — refusing to serve`,
                ));
                return;
              }
            } catch (_) { /* stat failed too — proceed, umask dance should've set 0600 */ }
          }
        }
        server.removeListener("error", onError);
        // After listen succeeds, keep a listener so downstream errors
        // (e.g., EMFILE under pressure, pipe disconnect, socket unlink)
        // don't crash the renderer — AND so the server object's
        // perceived listening state tracks reality. Previously this
        // handler just logged; the result was `isListening()` could
        // return true while the server was effectively dead, causing
        // `ensureIpcListening` to hot-path out and spawns to proceed
        // with a null-pointing socket env var. Null the state here so
        // the next `isListening()` returns false and recovery kicks in.
        server.on("error", (e) => {
          try { console.warn("[gryphon/ipc] server error:", e.message); } catch (_) {}
          if (this._server === server) {
            this._server = null;
            this._socketPath = null;
          }
        });
        server.on("close", () => {
          if (this._server === server) {
            this._server = null;
            this._socketPath = null;
          }
        });
        this._server = server;
        resolve();
      };

      if (IS_WINDOWS) {
        server.listen(socketPath, finishListen);
      } else {
        const prevUmask = process.umask(0o077);
        server.listen(socketPath, () => {
          process.umask(prevUmask);
          finishListen();
        });
      }
    });
  }

  /**
   * Stop accepting, tear down active connections, unlink the socket.
   * Safe to call multiple times. Never throws — shutdown failures are
   * logged and swallowed so plugin unload doesn't leave dangling state.
   */
  async close() {
    if (!this._server) return;
    const server = this._server;
    this._server = null;

    for (const sock of this._activeSockets) {
      try { sock.destroy(); } catch (_) { /* ignore */ }
    }
    this._activeSockets.clear();

    await new Promise((resolve) => {
      server.close(() => resolve());
    });

    if (this._socketPath && !IS_WINDOWS) {
      try {
        if (fs.existsSync(this._socketPath)) fs.unlinkSync(this._socketPath);
      } catch (_) { /* best-effort */ }
    }
    this._socketPath = null;
  }

  /** Current socket path (null before create / after close). */
  socketPath() {
    return this._socketPath;
  }

  /** True iff the server is currently bound and accepting connections. */
  isListening() {
    return this._server !== null;
  }

  _onConnection(socket) {
    // Round-12 F13: refuse beyond the concurrency cap. Attacker-driven
    // FD exhaustion is a DoS on the entire Obsidian renderer (shared fd
    // table), not just on Gryphon.
    if (this._activeSockets.size >= MAX_CONCURRENT_SOCKETS) {
      // end() flushes the rejection line before closing; destroy() would
      // race with the pending write and leave the client with no reason.
      this._safeWrite(socket, { resp: "error", error: "too-many-connections" });
      try { socket.end(); } catch (_) { /* ignore */ }
      return;
    }
    this._activeSockets.add(socket);
    socket.setEncoding("utf8");
    // Round-14 Q2: hard connection-lifetime cap. setTimeout(idle) is
    // defeated by a slow-loris that drips under the cap — setTimeout
    // resets on each data event. A fresh setTimeout with no
    // data-listener-reset acts as a true deadline from accept to now.
    // We start at REQUEST_LIFETIME_MS and extend to
    // MODAL_REQUEST_LIFETIME_MS when we see a `classify` request,
    // which legitimately blocks on user input.
    let deadlineTimer = setTimeout(() => {
      try { this._safeWrite(socket, { resp: "error", error: "request-lifetime-exceeded" }); } catch (_) {}
      try { socket.destroy(); } catch (_) {}
      this._activeSockets.delete(socket);
    }, REQUEST_LIFETIME_MS);
    // unref so a pending timer doesn't keep the process alive at unload
    if (deadlineTimer.unref) deadlineTimer.unref();
    const clearDeadline = () => { if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = null; } };

    let buffer = "";

    socket.on("data", (chunk) => {
      buffer += chunk;
      // Round-12 F11: cap per-line bytes so a misbehaving/adversarial
      // client can't grow the buffer without bound by withholding '\n'.
      if (buffer.length > MAX_LINE_BYTES) {
        this._safeWrite(socket, { resp: "error", error: "line-too-long" });
        // pause reads so further data doesn't grow buffer; end() after
        // the error write flushes then closes gracefully.
        try { socket.pause(); socket.end(); } catch (_) { /* ignore */ }
        buffer = "";
        clearDeadline();
        this._activeSockets.delete(socket);
        return;
      }
      let newlineIdx;
      while ((newlineIdx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        // Round-14 Q2: a `classify` request legitimately blocks on
        // user input via the modal, so extend the deadline the first
        // time we see one. Other request types should complete fast.
        if (line.includes('"classify"') && deadlineTimer) {
          clearTimeout(deadlineTimer);
          deadlineTimer = setTimeout(() => {
            try { this._safeWrite(socket, { resp: "error", error: "request-lifetime-exceeded" }); } catch (_) {}
            try { socket.destroy(); } catch (_) {}
            this._activeSockets.delete(socket);
          }, MODAL_REQUEST_LIFETIME_MS);
          if (deadlineTimer.unref) deadlineTimer.unref();
        }
        this._handleLine(socket, line).catch((e) => {
          this._safeWrite(socket, {
            resp: "error",
            error: String((e && e.message) || e),
          });
        });
      }
    });

    socket.on("close", () => { clearDeadline(); this._activeSockets.delete(socket); });
    socket.on("error", () => { clearDeadline(); this._activeSockets.delete(socket); });
  }

  async _handleLine(socket, line) {
    const trimmed = line.trim();
    if (!trimmed) return;

    let req;
    try {
      req = JSON.parse(trimmed);
    } catch (e) {
      this._safeWrite(socket, { resp: "error", error: "invalid-json", detail: e.message });
      return;
    }

    const reqId = req && req.id;
    const reqType = req && typeof req.req === "string" ? req.req : null;

    if (!reqType) {
      this._safeWrite(socket, { resp: "error", error: "missing-req-type", id: reqId });
      return;
    }

    const handler = this._handlers.get(reqType);
    if (!handler) {
      this._safeWrite(socket, { resp: "error", error: "unknown-req-type", reqType, id: reqId });
      return;
    }

    let result;
    try {
      result = await handler(req);
    } catch (e) {
      this._safeWrite(socket, {
        resp: "error",
        error: String((e && e.message) || e),
        id: reqId,
      });
      return;
    }

    // Echo id back; handler can override resp/other fields but id wins
    // from the request so the client can correlate.
    const response = Object.assign({}, result || {}, { id: reqId });
    if (!response.resp) response.resp = reqType;
    this._safeWrite(socket, response);
  }

  _safeWrite(socket, obj) {
    try {
      socket.write(JSON.stringify(obj) + "\n");
    } catch (_) { /* client may have disconnected */ }
  }
}

/**
 * Generate a socket path in the OS temp directory, unique per process.
 * Kept short (tmpdir is always under the 104-char Unix socket limit)
 * and randomised so concurrent plugin loads in separate Obsidian
 * windows don't collide.
 */
function defaultSocketPath() {
  const pid = process.pid;
  const randHex = crypto.randomBytes(4).toString("hex");
  if (IS_WINDOWS) {
    return `\\\\.\\pipe\\gryphon-${pid}-${randHex}`;
  }
  return path.join(os.tmpdir(), `gryphon-${pid}-${randHex}.sock`);
}

module.exports = {
  PermissionIPCServer,
  defaultSocketPath,
  MAX_LINE_BYTES,
  MAX_CONCURRENT_SOCKETS,
};
