"use strict";
/**
 * Antigravity CLI liveness test — spawn a trivial real completion
 * (`<antigravityPath> -p "..." --output-format stream-json
 * --dangerously-skip-permissions`) and assert it returns non-empty
 * assistant text.
 *
 * Issue #19: matches the hardened gemini-cli/codex-cli test-cli.ts —
 * `--version` alone would never catch the class of failure this provider
 * exists to route users away from (an account whose CLI protocol access
 * has been cut off but which still launches fine). Given Antigravity's
 * documented headless sharp edges (stdin hangs, silent stdout/stderr —
 * see antigravity-cli.ts header), a real-prompt liveness probe is even
 * more load-bearing here than for the other two CLIs.
 *
 * Timeout is 30s, not 5s: a live model round-trip needs materially more
 * headroom than a local `--version` call (which never leaves the
 * machine) to absorb normal latency variance, while staying well short
 * of a typical host connection timeout (90-180s) so THIS test's specific
 * failure message surfaces first, not a generic "no response."
 *
 * CORRECTION (2026-07-28): flags and event-parsing below were rewritten
 * to match the REAL `agy` v1.1.8 CLI, verified live — see
 * antigravity-cli.ts's header for the full verification writeup. The
 * old `-o stream-json --yes --no-color` argv and gemini-cli-shaped
 * `{ type: "message", ... }` parser never matched anything a real
 * install could produce.
 *
 * Returns { ok, message } with a user-facing message either way.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.testCli = testCli;
// These run in both the Obsidian renderer and headless Node paths (CLI probes,
// passive backend, hook/IPC subprocess) where `window` is unavailable, so bind
// the ambient timer global to a module-local. obsidianmd/prefer-window-timers
// accepts timer names that resolve to a local binding; window.* would throw in
// the headless paths.
const setTimeoutFn = setTimeout;
const { spawn } = require("child_process");
const { buildEnhancedPath } = require("../../utils");
const _LIVENESS_TIMEOUT_MS = 30000;
const _LIVENESS_PROMPT = "Reply with exactly the single word OK and nothing else.";
function testCli(antigravityPath) {
    return new Promise((resolve) => {
        if (!antigravityPath || typeof antigravityPath !== "string") {
            resolve({ ok: false, message: "No Antigravity CLI path configured." });
            return;
        }
        const isWindowsShim = process.platform === "win32" &&
            /\.(cmd|bat)$/i.test(antigravityPath);
        const opts = {
            env: { ...process.env, PATH: buildEnhancedPath() },
            // Close stdin — issue #19: `agy` otherwise blocks waiting on input
            // in headless mode.
            stdio: ["ignore", "pipe", "pipe"],
        };
        if (isWindowsShim)
            opts.shell = true;
        let proc;
        try {
            proc = spawn(antigravityPath, ["-p", _LIVENESS_PROMPT, "--output-format", "stream-json", "--dangerously-skip-permissions"], opts);
        }
        catch (err) {
            resolve({ ok: false, message: `Could not spawn Antigravity CLI: ${err.message}` });
            return;
        }
        let out = "";
        let err = "";
        let settled = false;
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            try {
                proc.kill("SIGTERM");
            }
            catch { }
            resolve(result);
        };
        proc.stdout.on("data", (d) => { out += d.toString(); });
        proc.stderr.on("data", (d) => { err += d.toString(); });
        proc.on("error", (e) => finish({ ok: false, message: `Spawn error: ${e.message}` }));
        proc.on("close", (code) => {
            if (/not (?:authenticated|logged in)|authentication (?:required|failed)/i.test(err)) {
                finish({
                    ok: false,
                    message: "Antigravity CLI reports it isn't authenticated. Run `agy` once in a terminal to sign in, then retry.",
                });
                return;
            }
            const text = _extractAssistantText(out);
            if (code === 0 && text) {
                finish({ ok: true, message: `Antigravity CLI works: got a real completion (${text.length} chars).` });
                return;
            }
            const tail = (err || out).trim().slice(-240);
            finish({
                ok: false,
                message: code === 0
                    ? `Antigravity CLI exited 0 but produced no completion text. ${tail}`
                    : `Antigravity CLI returned exit code ${code}. ${tail}`,
            });
        });
        setTimeoutFn(() => finish({ ok: false, message: `Antigravity CLI timed out (${_LIVENESS_TIMEOUT_MS / 1000}s) waiting for a completion.` }), _LIVENESS_TIMEOUT_MS);
    });
}
// Scan stream-json JSONL for assistant text — REAL shape, verified live
// against agy v1.1.8 (see antigravity-cli.ts header for the full
// writeup). Every line is `{ event, <event>: {...} }`, not gemini-cli's
// flat `{ type, ... }`. The terminal `result.response` (present only on
// `status: "SUCCESS"`) is authoritative and preferred; the
// step_update-accumulated agent_response text_delta is the fallback for
// a stream that never reached its result line. Kept intentionally
// minimal since this is a liveness probe, not a real turn.
function _extractAssistantText(stdout) {
    let accumulated = "";
    let resultResponse = null;
    for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim())
            continue;
        let evt;
        try {
            evt = JSON.parse(line);
        }
        catch {
            continue;
        }
        if (!evt || typeof evt !== "object")
            continue;
        if (evt.event === "step_update" && evt.step_update && evt.step_update.step_type === "agent_response") {
            if (typeof evt.step_update.text_delta === "string") {
                accumulated += evt.step_update.text_delta;
            }
        }
        if (evt.event === "result" && evt.result && evt.result.status === "SUCCESS" && typeof evt.result.response === "string") {
            resultResponse = evt.result.response;
        }
    }
    return (resultResponse !== null ? resultResponse : accumulated).trim();
}
