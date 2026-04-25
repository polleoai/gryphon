/**
 * Gryphon hook IPC client (v0.6.0).
 *
 * Tiny helper used by every hook script (src/hooks/*.js) to talk to
 * the Gryphon plugin's PermissionIPCServer. One request = one connection.
 *
 * The client is intentionally dependency-free: hook scripts run in the
 * Claude Code subprocess, invoked by CC per-tool-call, so they can't
 * reach into the bundled Obsidian plugin. Everything they need must
 * come from Node built-ins.
 */

const net = require("net");
const crypto = require("crypto");
const fs = require("fs");

const DEFAULT_TIMEOUT_MS = 30000;
const SOCKET_ENV_VAR = "GRYPHON_PERMISSION_SOCKET";
// Round-12 F12: cap the response read buffer so a misbehaving server
// can't OOM the hook by streaming unbounded bytes before a newline.
// Every legitimate response is tens to hundreds of bytes; 256 KiB is
// a safety margin that still catches runaway streams quickly.
const MAX_RESPONSE_BYTES = 256 * 1024;
// Optional per-hook trace log path. When set in the CC subprocess
// env, each hook appends one JSON line (ts, pid, hook name, input)
// to this file — so users submitting bug reports can confirm hooks
// are firing and include the raw inputs CC handed us. Plugin-side
// gate: `devCliDebug` setting (Settings → Gryphon → Diagnostics).
// Unset by default in normal operation. Writes are best-effort;
// hook scripts never throw on trace failure.
const TRACE_ENV_VAR = "GRYPHON_HOOK_TRACE_FILE";

/**
 * Send one JSON request to the Gryphon IPC socket and resolve with the
 * parsed JSON response. Rejects on timeout, connection error, or
 * unparseable response.
 *
 * The `id` field is auto-assigned if the caller didn't supply one so
 * correlation is always possible when debugging.
 */
async function sendToGryphon(request, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const socketPath = options.socketPath || process.env[SOCKET_ENV_VAR];

  if (!socketPath) {
    throw new Error(`${SOCKET_ENV_VAR} environment variable not set`);
  }

  const payload = Object.assign({ id: randomId() }, request);

  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let buffer = "";
    let settled = false;

    const done = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock.end(); } catch (_) { /* ignore */ }
      if (err) reject(err);
      else resolve(value);
    };

    const timer = setTimeout(() => {
      try { sock.destroy(); } catch (_) { /* ignore */ }
      done(new Error("ipc-timeout"));
    }, timeoutMs);

    sock.setEncoding("utf8");
    sock.on("data", (chunk) => {
      buffer += chunk;
      // Round-12 F12: drop the connection if the response grows past
      // our cap with no terminating newline — a misbehaving server
      // shouldn't be able to grow hook memory without bound.
      if (buffer.length > MAX_RESPONSE_BYTES) {
        done(new Error("response-too-long"));
        return;
      }
      const nl = buffer.indexOf("\n");
      if (nl >= 0) {
        const line = buffer.slice(0, nl);
        try { done(null, JSON.parse(line)); }
        catch (e) { done(e); }
      }
    });
    sock.on("error", (e) => done(e));
    sock.once("connect", () => {
      try {
        sock.write(JSON.stringify(payload) + "\n");
      } catch (e) {
        done(e);
      }
    });
  });
}

/**
 * Fire-and-forget telemetry event. Errors are swallowed — telemetry
 * must never break a tool call. Short timeout because the plugin-side
 * handler is in-memory append only.
 */
async function emitEvent(type, fields = {}) {
  try {
    await sendToGryphon(
      Object.assign({ req: "event", type }, fields),
      { timeoutMs: 5000 },
    );
  } catch (_) { /* fire-and-forget */ }
}

/**
 * Read all of stdin as a single JSON document. Hook scripts get their
 * input this way.
 */
async function readStdinJson() {
  return new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { buf += chunk; });
    process.stdin.on("end", () => {
      const trimmed = buf.trim();
      if (!trimmed) {
        resolve({});
        return;
      }
      try { resolve(JSON.parse(trimmed)); }
      catch (e) { reject(e); }
    });
    process.stdin.on("error", reject);
  });
}

/**
 * Write a JSON object to stdout and resolve once the chunk has been
 * flushed to the kernel. Hooks MUST `await` this before `process.exit()`:
 * `process.exit` does not drain queued I/O when stdout is a pipe (see
 * Node docs for `process.exit`), so a synchronous `write` + immediate
 * exit can truncate the JSON under load. CC treats truncated output as
 * a hook failure, which leaves enforcement dependent on CC's
 * (unverified) default-on-failure behavior.
 *
 * No trailing newline — CC parses a raw JSON document, not NDJSON.
 */
function writeStdoutJson(obj) {
  return new Promise((resolve) => {
    process.stdout.write(JSON.stringify(obj || {}), () => resolve());
  });
}

/** Short, readable id for request/response correlation and logs. */
function randomId() {
  return `h-${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
}

/**
 * Install a wall-clock deadline + crash-handler scaffold for a fail-closed
 * hook. Use this any time a hook's safety contract requires it to emit
 * a bounded-time decision: PreToolUse and SessionStart are the two
 * current callers, but any future hook that gates an action should
 * adopt this idiom.
 *
 * Why this is a shared helper (Round-11 follow-up to F2 + F9):
 *   `readStdinJson()` waits for stdin's `end` event with no timeout.
 *   If CC writes nothing and never closes, the hook hangs until CC's
 *   own SIGKILL — whose default-on-timeout behaviour is undocumented
 *   and could silently bypass our fail-closed posture. The two
 *   safety-critical hooks each had a hand-rolled deadline timer +
 *   idempotent emitAndExit; both were exact duplicates of each other.
 *   Promoting to one helper means every future fail-closed hook gets
 *   the protection by construction.
 *
 * The returned `emitAndExit(payload)` is idempotent — first caller
 * wins, later callers (timer, crash handler, normal completion) are
 * silently no-op'd. This is the property that makes the deadline
 * race-safe: whichever path reaches it first commits the response.
 *
 * @param {object} opts
 *   deadlineMs       — wall-clock budget for the entire hook
 *   onTimeoutPayload — JSON to emit if the deadline fires (the
 *                      hook's fail-closed shape)
 *   onCrashPayload   — JSON to emit from main().catch(crashHandler)
 *                      (typically a more specific "crashed" wording)
 *
 * @returns {{ emitAndExit, crashHandler }}
 */
function installHookDeadline({ deadlineMs, onTimeoutPayload, onCrashPayload }) {
  if (typeof deadlineMs !== "number" || deadlineMs <= 0) {
    throw new TypeError("installHookDeadline: deadlineMs must be a positive number");
  }
  let emitted = false;
  async function emitAndExit(payload) {
    if (emitted) return;
    emitted = true;
    try {
      await writeStdoutJson(payload);
    } catch (_) { /* stdout closed — nothing to do */ }
    process.exit(0);
  }
  const timer = setTimeout(() => { emitAndExit(onTimeoutPayload); }, deadlineMs);
  // Don't keep the event loop alive just for this timer — the hook
  // exits as soon as main() finishes, deadline timer or not.
  timer.unref();
  return {
    emitAndExit,
    crashHandler: () => emitAndExit(onCrashPayload),
  };
}

/**
 * Append a JSON trace line (ts, pid, hookName, input) to
 * $GRYPHON_HOOK_TRACE_FILE. Silent no-op when unset, which is the
 * default. Enabled opt-in via Settings → Gryphon → Diagnostics → CLI
 * debug logging; written to confirm hooks are firing and to capture
 * the raw CC input shape for bug-report attachment.
 */
function traceHook(hookName, input) {
  const file = process.env[TRACE_ENV_VAR];
  if (!file) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    pid: process.pid,
    hook: hookName,
    input: input || null,
  }) + "\n";
  try { fs.appendFileSync(file, line); } catch (_) { /* best-effort */ }
}

module.exports = {
  sendToGryphon,
  emitEvent,
  readStdinJson,
  writeStdoutJson,
  randomId,
  traceHook,
  installHookDeadline,
  SOCKET_ENV_VAR,
  TRACE_ENV_VAR,
  DEFAULT_TIMEOUT_MS,
};
