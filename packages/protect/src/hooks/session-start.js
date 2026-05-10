#!/usr/bin/env node
/**
 * SessionStart hook (v0.6.0 Stage 7 + Round-10 F9 fix + Round-11
 * shared-helper refactor).
 *
 * Verifies the Gryphon IPC server is reachable before letting the CC
 * session start. If it isn't, returns `{continue: false, stopReason}`
 * so CC refuses to begin. This is the bootstrap fail-closed gate
 * that keeps a user from accidentally running a CC session against a
 * crashed/disabled plugin and getting silent unprotection.
 *
 * Reachability test: send a `ping` request. The plugin replies
 * `{ok: true}` if its IPC server + handler registry are live. Any
 * timeout, connection error, or non-ok response → fail-closed.
 *
 * Special case: when GRYPHON_PERMISSION_SOCKET isn't set in the
 * environment, the user has hooks enabled but Gryphon didn't wire the
 * socket. Treat that as fail-closed too — same rationale.
 *
 * Defense in depth (Round-10 F9 + Round-11 refactor):
 *   1. Per-step try/catch inside main()
 *   2. PING_TIMEOUT_MS bounds the IPC round-trip
 *   3. installHookDeadline() bounds the WHOLE hook including
 *      readStdinJson — without it, a hung stdin would let CC's 10s
 *      hook timeout fire with undocumented behavior.
 *
 * Note on `source`: CC tells us `source: "startup"` for fresh sessions
 * and `source: "resume"` for resumed sessions. We block both.
 */

const {
  readStdinJson,
  sendToGryphon,
  traceHook,
  installHookDeadline,
  SOCKET_ENV_VAR,
} = require("./common/ipc-client");

const PING_TIMEOUT_MS = 5_000;
// CC's configured SessionStart hook timeout is 10s. Self-deadline at
// 8s leaves a 2s gap so our fail-closed lands first.
const OVERALL_DEADLINE_MS = 8_000;

const { emitAndExit, crashHandler } = installHookDeadline({
  deadlineMs: OVERALL_DEADLINE_MS,
  onTimeoutPayload: {
    continue: false,
    stopReason:
      `Gryphon security bootstrap timed out after ${OVERALL_DEADLINE_MS / 1000}s ` +
      `and fell back to deny. The plugin may be unloaded or unresponsive — ` +
      `reload Gryphon and retry.`,
  },
  onCrashPayload: {
    continue: false,
    stopReason: "Gryphon security bootstrap crashed.",
  },
});

async function main() {
  let input = null;
  try {
    input = await readStdinJson();
  } catch (_) { /* tolerate — we still attempt the ping */ }
  traceHook("SessionStart", input);

  if (!process.env[SOCKET_ENV_VAR]) {
    await emitAndExit({
      continue: false,
      stopReason:
        "Gryphon security layer not reachable (no socket env var set). " +
        "The plugin may have been disabled or crashed. Restart Obsidian " +
        "or re-enable the plugin, then try again.",
    });
    return;
  }

  try {
    const resp = await sendToGryphon(
      { req: "ping", source: input && input.source },
      { timeoutMs: PING_TIMEOUT_MS },
    );
    if (!resp || resp.ok !== true) {
      await emitAndExit({
        continue: false,
        stopReason:
          "Gryphon security layer responded but reported not-ready. " +
          "Restart Obsidian or re-enable the plugin, then try again.",
      });
      return;
    }
  } catch (e) {
    await emitAndExit({
      continue: false,
      stopReason:
        `Gryphon security layer not reachable (${(e && e.message) || e}). ` +
        `The plugin may have been disabled or crashed. Restart Obsidian ` +
        `or re-enable the plugin, then try again.`,
    });
    return;
  }

  await emitAndExit({ continue: true });
}

main().catch(crashHandler);
