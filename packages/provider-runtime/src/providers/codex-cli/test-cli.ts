/**
 * Codex CLI liveness test — spawn a trivial real completion
 * (`<codexPath> exec --json --skip-git-repo-check --sandbox read-only -C
 * <tmpdir> -- "..."`) and assert it returns non-empty assistant text.
 *
 * Issue #19: `--version` is NOT a liveness check — it only proves the
 * binary launches, not that it can actually serve a completion (e.g. a
 * CLI that launches fine but isn't logged in, or whose account has lost
 * access, still passes `--version`). This test issues a real (billable /
 * quota-consuming) round-trip so the health check actually exercises the
 * failure mode it needs to catch. `--sandbox read-only` and a scratch
 * tmpdir keep the probe side-effect-free.
 *
 * Timeout is 30s, not 5s: a live model round-trip needs materially more
 * headroom than a local `--version` call (which never leaves the
 * machine) to absorb normal latency variance, while staying well short
 * of a typical host connection timeout (90-180s) so THIS test's specific
 * failure message surfaces first, not a generic "no response."
 *
 * Returns { ok, message } with a user-facing message either way.
 */

// These run in both the Obsidian renderer and headless Node paths (CLI probes,
// passive backend, hook/IPC subprocess) where `window` is unavailable, so bind
// the ambient timer global to a module-local. obsidianmd/prefer-window-timers
// accepts timer names that resolve to a local binding; window.* would throw in
// the headless paths.
const setTimeoutFn = setTimeout;


const { spawn } = require("child_process") as typeof import("child_process");
const os = require("os") as typeof import("os");
const { buildEnhancedPath } = require("../../utils");
const { killProcessTree } = require("../../subprocess-registry");

const _LIVENESS_TIMEOUT_MS = 30000;
const _LIVENESS_PROMPT = "Reply with exactly the single word OK and nothing else.";

function testCli(codexPath: any) {
  return new Promise((resolve) => {
    if (!codexPath || typeof codexPath !== "string") {
      resolve({ ok: false, message: "No Codex CLI path configured." });
      return;
    }

    const isWindowsShim =
      process.platform === "win32" &&
      /\.(cmd|bat)$/i.test(codexPath);
    const opts: Record<string, any> = {
      env: { ...process.env, PATH: buildEnhancedPath() },
      // Close stdin so a CLI that misinterprets missing flags as
      // "wait for interactive input" fails fast instead of hanging.
      stdio: ["ignore", "pipe", "pipe"],
    };
    if (isWindowsShim) opts.shell = true;

    let proc;
    try {
      proc = spawn(
        codexPath,
        [
          "exec", "--json", "--skip-git-repo-check",
          "--sandbox", "read-only", "-C", os.tmpdir(),
          "--", _LIVENESS_PROMPT,
        ],
        opts,
      );
    } catch (err) {
      resolve({ ok: false, message: `Could not spawn Codex CLI: ${(err as Error).message}` });
      return;
    }

    let out = "";
    let err = "";
    let settled = false;
    // Probe cleanup uses killProcessTree, not proc.kill.
    //
    // A Windows .cmd/.bat shim is spawned with shell:true, so the direct child is
    // cmd.exe and the real CLI is a GRANDCHILD — SIGTERM to the direct child
    // orphans it. Gryphon already solved this for provider spawns (v2.3.1
    // subprocess-registry); the probes were written without it and leaked a CLI
    // process per run, including on every release gate via live-cli-probe.sh.
    //
    // The liveness timer is also captured and cleared: unstored, it keeps the
    // event loop alive for its full duration after a fast probe, delaying exit of
    // the very script the gate runs.
    let timer: any = null;
    const finish = (result: any) => {
      if (settled) return;
      settled = true;
      if (timer) { try { clearTimeout(timer); } catch {} timer = null; }
      try { killProcessTree(proc, "SIGTERM"); } catch {}
      resolve(result);
    };

    proc.stdout.on("data", (d: any) => { out += d.toString(); });
    proc.stderr.on("data", (d: any) => { err += d.toString(); });
    proc.on("error", (e: any) => finish({ ok: false, message: `Spawn error: ${e.message}` }));
    proc.on("close", (code: any) => {
      if (/not logged in|run [`'"]?codex login|authentication failed/i.test(err)) {
        finish({ ok: false, message: "Codex CLI is not logged in. Run `codex login` in a terminal, then retry." });
        return;
      }

      const text = _extractAgentText(out);
      if (code === 0 && text) {
        finish({ ok: true, message: `Codex CLI works: got a real completion (${text.length} chars).` });
        return;
      }

      const tail = (err || out).trim().slice(-240);
      finish({
        ok: false,
        message: code === 0
          ? `Codex CLI exited 0 but produced no completion text. ${tail}`
          : `Codex CLI returned exit code ${code}. ${tail}`,
      });
    });

    setTimeoutFn(() => finish({ ok: false, message: `Codex CLI timed out (${_LIVENESS_TIMEOUT_MS / 1000}s) waiting for a completion.` }), _LIVENESS_TIMEOUT_MS);
  });
}

// Scan codex exec's JSONL for the agent_message item's final text — the
// same event CodexProvider._processEvent reads from item.completed. Kept
// intentionally minimal (no session/tool/error handling) since this is a
// liveness probe, not a real turn.
function _extractAgentText(stdout: string): string {
  let text = "";
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let evt: any;
    try { evt = JSON.parse(line); } catch { continue; }
    if (evt && evt.type === "item.completed" && evt.item && evt.item.type === "agent_message" &&
        typeof evt.item.text === "string") {
      text = evt.item.text;
    }
  }
  return text.trim();
}

export { testCli };
