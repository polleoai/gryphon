"use strict";
/**
 * Gemini CLI liveness test — spawn a trivial real completion
 * (`<geminiPath> -p "..." -o stream-json --skip-trust --approval-mode
 * default`) and assert it returns non-empty assistant text.
 *
 * Issue #19: `--version` is NOT a liveness check — it only proves the
 * binary launches, not that it can actually serve a completion. The
 * 2026-07-27 incident this hardening responds to is exactly this gap:
 * Google cut gemini-cli off the Gemini Code Assist individuals tier, the
 * CLI now exits 0 with empty stdout (reasonCode: 'UNSUPPORTED_CLIENT' on
 * stderr), and `gemini --version` keeps succeeding regardless — so the
 * old smoke test reported healthy while the provider was dead. This test
 * issues a real (billable / quota-consuming) round-trip so the health
 * check actually exercises the failure mode it needs to catch.
 *
 * Timeout is 30s, not 5s: a live model round-trip needs materially more
 * headroom than a local `--version` call (which never leaves the
 * machine) to absorb normal latency variance, while staying well short
 * of a typical host connection timeout (90-180s) so THIS test's specific
 * failure message surfaces first, not a generic "no response."
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
// Same reason as setTimeoutFn: obsidianmd/prefer-window-timers accepts a
// timer name that resolves to a local binding, and window.clearTimeout
// would throw in the headless paths these probes run in.
const clearTimeoutFn = clearTimeout;
const { spawn } = require("child_process");
const { buildEnhancedPath } = require("../../utils");
const { killProcessTree } = require("../../subprocess-registry");
const _LIVENESS_TIMEOUT_MS = 30000;
const _LIVENESS_PROMPT = "Reply with exactly the single word OK and nothing else.";
function testCli(geminiPath) {
    return new Promise((resolve) => {
        if (!geminiPath || typeof geminiPath !== "string") {
            resolve({ ok: false, message: "No Gemini CLI path configured." });
            return;
        }
        const isWindowsShim = process.platform === "win32" &&
            /\.(cmd|bat)$/i.test(geminiPath);
        const opts = {
            env: { ...process.env, PATH: buildEnhancedPath() },
            // Close stdin so a CLI that misinterprets missing flags as
            // "wait for interactive input" fails fast instead of hanging.
            stdio: ["ignore", "pipe", "pipe"],
        };
        if (isWindowsShim)
            opts.shell = true;
        let proc;
        try {
            proc = spawn(geminiPath, ["-p", _LIVENESS_PROMPT, "-o", "stream-json", "--skip-trust", "--approval-mode", "default"], opts);
        }
        catch (err) {
            resolve({ ok: false, message: `Could not spawn Gemini CLI: ${err.message}` });
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
        let timer = null;
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            if (timer) {
                try {
                    clearTimeoutFn(timer);
                }
                catch { }
                timer = null;
            }
            try {
                killProcessTree(proc, "SIGTERM");
            }
            catch { }
            resolve(result);
        };
        proc.stdout.on("data", (d) => { out += d.toString(); });
        proc.stderr.on("data", (d) => { err += d.toString(); });
        proc.on("error", (e) => finish({ ok: false, message: `Spawn error: ${e.message}` }));
        proc.on("close", (code) => {
            // Issue #19: this is the specific failure the old --version-only
            // check could never catch — surface it by name rather than the
            // generic "no output" message below.
            if (/UNSUPPORTED_CLIENT/.test(err)) {
                finish({
                    ok: false,
                    message: "Gemini CLI reports this account is no longer supported for Gemini " +
                        "Code Assist individuals. Switch Provider to Antigravity CLI in " +
                        "Settings → Gryphon → Provider, or use an API provider instead.",
                });
                return;
            }
            const text = _extractAssistantText(out);
            if (code === 0 && text) {
                finish({ ok: true, message: `Gemini CLI works: got a real completion (${text.length} chars).` });
                return;
            }
            const tail = (err || out).trim().slice(-240);
            finish({
                ok: false,
                message: code === 0
                    ? `Gemini CLI exited 0 but produced no completion text. ${tail}`
                    : `Gemini CLI returned exit code ${code}. ${tail}`,
            });
        });
        setTimeoutFn(() => finish({ ok: false, message: `Gemini CLI timed out (${_LIVENESS_TIMEOUT_MS / 1000}s) waiting for a completion.` }), _LIVENESS_TIMEOUT_MS);
    });
}
// Scan stream-json JSONL for assistant message text, accumulating deltas
// the same way GeminiCliProvider._processEvent does — kept intentionally
// minimal (no session/tool/error handling) since this is a liveness probe,
// not a real turn.
function _extractAssistantText(stdout) {
    let text = "";
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
        if (evt && evt.type === "message" && evt.role === "assistant" && typeof evt.content === "string") {
            text = evt.delta ? text + evt.content : evt.content;
        }
    }
    return text.trim();
}
