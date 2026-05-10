/**
 * Gemini CLI smoke test — spawn `<geminiPath> --version` to verify the
 * binary path is correct and the CLI is executable. Does not require
 * an API key (--version does not call the model).
 *
 * Returns { ok, message } with a user-facing message either way.
 */

const { spawn } = require("child_process");
const { buildEnhancedPath } = require("../../utils");

function testCli(geminiPath) {
  return new Promise((resolve) => {
    if (!geminiPath || typeof geminiPath !== "string") {
      resolve({ ok: false, message: "No Gemini CLI path configured." });
      return;
    }

    const isWindowsShim =
      process.platform === "win32" &&
      /\.(cmd|bat)$/i.test(geminiPath);
    const opts = {
      env: { ...process.env, PATH: buildEnhancedPath() },
      stdio: ["ignore", "pipe", "pipe"],
    };
    if (isWindowsShim) opts.shell = true;

    let proc;
    try {
      proc = spawn(geminiPath, ["--version"], opts);
    } catch (err) {
      resolve({ ok: false, message: `Could not spawn Gemini CLI: ${err.message}` });
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
      // gemini --version prints just a version number (e.g. "0.39.1") so
      // we accept either a numeric version or a line that mentions gemini.
      const looksValid = code === 0 && (/^\d+\.\d+/.test(version) || /gemini/i.test(version));
      if (looksValid) {
        finish({ ok: true, message: `Gemini CLI works: ${version}` });
      } else {
        finish({
          ok: false,
          message: `Gemini CLI returned exit code ${code}. ${(err || out).trim().slice(0, 240)}`,
        });
      }
    });

    setTimeout(() => finish({ ok: false, message: "Gemini CLI timed out (5s)." }), 5000);
  });
}

module.exports = { testCli };
