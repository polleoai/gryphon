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

import {
  readStdinJson,
  writeStdoutJson,
  sendToGryphon,
  traceHook,
  SOCKET_ENV_VAR,
} from "./common/ipc-client";

const SESSION_END_TIMEOUT_MS = 2000;

async function main() {
  let input: Record<string, unknown> | null = null;
  try {
    input = await readStdinJson();
  } catch { /* tolerate */ }
  traceHook("SessionEnd", input);

  const sessionId = input && input.session_id;
  if (sessionId && process.env[SOCKET_ENV_VAR]) {
    try {
      await sendToGryphon(
        { req: "session_end", sessionId },
        { timeoutMs: SESSION_END_TIMEOUT_MS },
      );
    } catch { /* fire-and-forget */ }
  }

  await writeStdoutJson({});
  process.exit(0);
}

main().catch(async () => {
  try { await writeStdoutJson({}); } catch { /* ignore */ }
  process.exit(0);
});
