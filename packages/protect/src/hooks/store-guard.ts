#!/usr/bin/env node
/**
 * Store-guard PreToolUse / BeforeTool hook (issue #30, G2).
 *
 * Runs when Protected Mode is OFF for codex / gemini / antigravity. It
 * enforces exactly one rule — the approvals-store rule `classify` applies in
 * every mode: no tool call may write, edit or run a command aimed at
 * Gryphon's own trust stores (security-settings.json, mcp-approvals.json and
 * this script's own directory). Everything else is allowed with no prompt;
 * the user chose to run unguarded and this doesn't second-guess that.
 *
 * Self-contained by design: it never opens a socket and requires only node
 * builtins, so it works in a host with no IPC server and no `hooks/` on disk
 * (an embedder installed from the community directory ships `main.js` only).
 * The build bundles it into one file, embedded as a string in
 * @gryphon/protect and written under the approvals dir before each spawn.
 *
 * Invocation: `node store-guard.js <dialect> <approvalsDir>`. The dialect
 * and the dir are baked into the hook command, not inherited from the CLI's
 * environment — a dialect lost on the way degrades to a payload the CLI
 * can't read, which several CLIs treat as allow. Env vars are a fallback.
 *
 * Deny-only and fail-closed: the guarded set is the union of the passed dir
 * and this process's own approvalsDir(), so a tampered XDG_CONFIG_HOME /
 * APPDATA can't move the target; a crash, a deadline or (for antigravity)
 * an unreadable payload is a deny.
 */

const { approvalsStoreVerdict } = require("../mcp-approvals");
const { normalizeAntigravityInput, buildHookDecision } = require("./common/dialects");

const DIALECTS = new Set(["claude", "codex", "gemini", "antigravity"]);
const argDialect = process.argv[2];
const dialect = DIALECTS.has(argDialect) ? argDialect : (process.env.GRYPHON_HOOK_DIALECT || "claude");
const guardedDir = process.argv[3] || process.env.GRYPHON_APPROVALS_DIR || "";

// The decision is a pure function of the payload — no IPC to wait on — so
// the only way to run long is a stdin that never closes.
const DEADLINE_MS = 20_000;

const REFUSAL =
  "Gryphon refused this change: it targets Gryphon's own security settings, " +
  "which only Gryphon's settings screen can change. This applies even with " +
  "Protected Mode off.";

let emitted = false;
function emit(decision: string, reason?: string) {
  if (emitted) return;
  emitted = true;
  process.stdout.write(JSON.stringify(buildHookDecision(dialect, decision, reason)), () => process.exit(0));
}

// A plain-Node subprocess: no `window`. Bound to a local so
// obsidianmd/prefer-window-timers accepts it (same idiom as ipc-client).
const setTimeoutFn = setTimeout;
setTimeoutFn(() => emit("deny", "Gryphon's settings check timed out and fell back to deny."), DEADLINE_MS).unref();

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { buf += c; });
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", reject);
  });
}

async function main() {
  let input: any;
  try {
    const raw = (await readStdin()).trim();
    input = raw ? JSON.parse(raw) : {};
  } catch (_) {
    emit("deny", "Gryphon's settings check could not parse the tool request.");
    return;
  }
  if (dialect === "antigravity") {
    // Antigravity runs under --dangerously-skip-permissions, so an
    // unreadable payload can't fall through to the CLI's own prompt.
    const normalized = normalizeAntigravityInput(input);
    if (!normalized || typeof normalized.tool_name !== "string" || !normalized.tool_name) {
      emit("deny", "Gryphon could not read this Antigravity tool request, so it was refused.");
      return;
    }
    input = normalized;
  }
  const tool = input && input.tool_name;
  const toolInput = input && input.tool_input;
  if (typeof tool !== "string" || !toolInput || typeof toolInput !== "object") {
    emit("allow");
    return;
  }
  const verdict = approvalsStoreVerdict(tool, toolInput, {
    // CLIs run hooks from the agent's cwd; use it when the payload has none,
    // so a relative path still resolves somewhere.
    cwd: typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd(),
    extraDirs: guardedDir ? [guardedDir] : [],
    // E7-1: decide well inside the CLI's hook timeout — a killed hook is
    // "allow" in several CLIs. Past this the check refuses (fail closed).
    deadlineAt: Date.now() + 15000,
  });
  emit(verdict ? "deny" : "allow", verdict ? REFUSAL : undefined);
}

main().catch(() => emit("deny", "Gryphon's settings check crashed."));
