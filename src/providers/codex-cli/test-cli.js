/**
 * Codex CLI smoke test — spawn `<codexPath> --version` to verify the
 * binary path is correct and the CLI is executable. Symmetric with the
 * test-key buttons on the SDK providers; this is the CLI equivalent.
 *
 * Returns { ok, message } with a user-facing message either way.
 */

const { spawn } = require("child_process");
const { buildEnhancedPath } = require("../../utils");

function testCli(codexPath) {
  return new Promise((resolve) => {
    if (!codexPath || typeof codexPath !== "string") {
      resolve({ ok: false, message: "No Codex CLI path configured." });
      return;
    }

    const isWindowsShim =
      process.platform === "win32" &&
      /\.(cmd|bat)$/i.test(codexPath);
    const opts = {
      env: { ...process.env, PATH: buildEnhancedPath() },
      stdio: ["ignore", "pipe", "pipe"],
    };
    if (isWindowsShim) opts.shell = true;

    let proc;
    try {
      proc = spawn(codexPath, ["--version"], opts);
    } catch (err) {
      resolve({ ok: false, message: `Could not spawn Codex CLI: ${err.message}` });
      return;
    }

    let out = "";
    let err = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { proc.kill("SIGTERM"); } catch {}
      resolve(result);
    };

    proc.stdout.on("data", (d) => { out += d.toString(); });
    proc.stderr.on("data", (d) => { err += d.toString(); });
    proc.on("error", (e) => finish({ ok: false, message: `Spawn error: ${e.message}` }));
    proc.on("close", (code) => {
      const version = (out || err).trim().split(/\r?\n/)[0] || "";
      if (code === 0 && /codex/i.test(version)) {
        finish({ ok: true, message: `Codex CLI works: ${version}` });
      } else {
        finish({
          ok: false,
          message: `Codex CLI returned exit code ${code}. ${(err || out).trim().slice(0, 240)}`,
        });
      }
    });

    setTimeout(() => finish({ ok: false, message: "Codex CLI timed out (5s)." }), 5000);
  });
}

module.exports = { testCli };
