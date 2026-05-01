#!/usr/bin/env node
/**
 * SessionEnd hook (v0.6.0 Stage 7).
 *
 * Tells the plugin's IPC server to drop in-memory `sessionFlags` for
 * the ending session — primarily the `untrustedContentActive` flag
 * set by WebFetch / WebSearch / Bash-network during the session.
 *
 * Fire-and-forget: a failed cleanup ping is fine (the plugin's
 * Map will fill up by ~50 bytes per never-ended session and gets
 * flushed on plugin reload). Never block CC's exit on the IPC call.
 *
 * CC stdout: always `{}` — observe-only.
 */

const {
  readStdinJson,
  writeStdoutJson,
  sendToGryphon,
  traceHook,
  SOCKET_ENV_VAR,
} = require("./common/ipc-client");

const SESSION_END_TIMEOUT_MS = 2000;

async function main() {
  let input = null;
  try {
    input = await readStdinJson();
  } catch (_) { /* tolerate */ }
  traceHook("SessionEnd", input);

  const sessionId = input && input.session_id;
  if (sessionId && process.env[SOCKET_ENV_VAR]) {
    try {
      await sendToGryphon(
        { req: "session_end", sessionId },
        { timeoutMs: SESSION_END_TIMEOUT_MS },
      );
    } catch (_) { /* fire-and-forget */ }
  }

  await writeStdoutJson({});
  process.exit(0);
}

main().catch(async () => {
  try { await writeStdoutJson({}); } catch (_) { /* ignore */ }
  process.exit(0);
});
