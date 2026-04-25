#!/usr/bin/env node
/**
 * Notification hook (v0.6.0 Stage 7).
 *
 * Routes Claude Code's system notifications (permission-mode changes,
 * "waiting for input" prompts, etc.) into Obsidian's Notice API via
 * the plugin IPC server. Useful when CC is running in non-interactive
 * mode inside Gryphon's chat — without this, those notifications would
 * only surface on the controlling terminal that the user can't see.
 *
 * Fire-and-forget. CC stdout always `{}` — observation-only hook.
 */

const {
  readStdinJson,
  writeStdoutJson,
  sendToGryphon,
  traceHook,
  SOCKET_ENV_VAR,
} = require("./common/ipc-client");

const NOTICE_TIMEOUT_MS = 1000;

async function main() {
  let input = null;
  try {
    input = await readStdinJson();
  } catch (_) { /* tolerate */ }
  traceHook("Notification", input);

  const message = input && typeof input.message === "string" ? input.message : "";
  if (message && process.env[SOCKET_ENV_VAR]) {
    try {
      await sendToGryphon(
        {
          req: "notice",
          level: "info",
          message: message.length > 280 ? message.slice(0, 277) + "..." : message,
          notificationType: input.notification_type || null,
          sessionId: input.session_id || null,
        },
        { timeoutMs: NOTICE_TIMEOUT_MS },
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
