"use strict";
/**
 * Claude Code CLI liveness test — spawn a trivial real completion and assert
 * it returns non-empty assistant text.
 *
 * Claude Code was the ONLY CLI provider without one. `scripts/live-cli-probe.sh`
 * reported it as "installed, no live coverage" — meaning the provider Gryphon
 * treats as its primary path was the single one never exercised by the release
 * gate. Same contract as the codex-cli / gemini-cli / antigravity-cli probes:
 * `{ ok, message }`, never throws, bounded.
 *
 * Deliberately uses `--print` with `--output-format stream-json`: a
 * `--version` check would stay green on an account whose CLI launches fine
 * but can no longer complete a turn — exactly the failure mode that made the
 * gemini-cli probe worthless (issue #19).
 *
 * NOTE on `--print`: memory `feedback_avoid_claude_print_flag` warns against
 * `-p`/`--print` for the PROVIDER path (it wants a persistent stream-json
 * session, and per-call `-p` carries cost/behaviour risk across a real
 * conversation). That guidance is about serving turns. This is a one-shot
 * liveness probe with a 6-word prompt, where a stateless single call is the
 * correct shape and a persistent session would be strictly worse.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.testCli = testCli;
// Bound the ambient timer to a module-local: these run in both the Obsidian
// renderer and headless Node paths, where `window` is unavailable.
const setTimeoutFn = setTimeout;
// Same reason as setTimeoutFn: obsidianmd/prefer-window-timers accepts a
// timer name that resolves to a local binding, and window.clearTimeout
// would throw in the headless paths these probes run in.
const clearTimeoutFn = clearTimeout;
const { spawn } = require("child_process");
const { buildEnhancedPath } = require("../../utils");
const { killProcessTree } = require("../../subprocess-registry");
const _LIVENESS_TIMEOUT_MS = 45000; // CC cold start is slower than the others
const _LIVENESS_PROMPT = "Reply with exactly the single word OK and nothing else.";
function testCli(claudePath) {
    return new Promise((resolve) => {
        if (!claudePath || typeof claudePath !== "string") {
            resolve({ ok: false, message: "No Claude Code CLI path configured." });
            return;
        }
        const isWindowsShim = process.platform === "win32" && /\.(cmd|bat)$/i.test(claudePath);
        const opts = {
            env: { ...process.env, PATH: buildEnhancedPath() },
            // Close stdin so the CLI cannot block waiting on input in headless mode.
            stdio: ["ignore", "pipe", "pipe"],
        };
        if (isWindowsShim)
            opts.shell = true;
        let proc;
        try {
            proc = spawn(claudePath, ["--print", _LIVENESS_PROMPT, "--output-format", "stream-json", "--verbose"], opts);
        }
        catch (err) {
            resolve({ ok: false, message: `Could not spawn Claude Code CLI: ${err.message}` });
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
            // Auth phrasing is classified by the caller (live-cli-probe.sh treats
            // account/tier failures as environment, not a release blocker), so the
            // wording here needs to stay recognisable to that matcher.
            if (/not (?:authenticated|logged in)|authentication (?:required|failed)|please run .?claude login/i.test(err)) {
                finish({
                    ok: false,
                    message: "Claude Code CLI reports it isn't authenticated. Run `claude` once in a terminal to sign in, then retry.",
                });
                return;
            }
            const text = _extractAssistantText(out);
            if (code === 0 && text) {
                finish({ ok: true, message: `Claude Code CLI works: got a real completion (${text.length} chars).` });
                return;
            }
            const tail = (err || out).trim().slice(-240);
            finish({
                ok: false,
                message: code === 0
                    ? `Claude Code CLI exited 0 but produced no completion text. ${tail}`
                    : `Claude Code CLI returned exit code ${code}. ${tail}`,
            });
        });
        timer = setTimeoutFn(() => finish({ ok: false, message: `Claude Code CLI timed out (${_LIVENESS_TIMEOUT_MS / 1000}s) waiting for a completion.` }), _LIVENESS_TIMEOUT_MS);
    });
}
/**
 * Scan Claude Code's stream-json JSONL for assistant text.
 *
 * Shape: `{ type: "assistant", message: { content: [{ type: "text", text }] } }`
 * per line, with a terminal `{ type: "result", result: "<text>" }`. The result
 * line is authoritative when present; accumulated assistant text is the
 * fallback for a stream that ended early. Intentionally minimal — this is a
 * liveness probe, not a turn parser.
 */
function _extractAssistantText(stdout) {
    let accumulated = "";
    let resultText = null;
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
        if (evt.type === "assistant" && evt.message && Array.isArray(evt.message.content)) {
            for (const block of evt.message.content) {
                if (block && block.type === "text" && typeof block.text === "string") {
                    accumulated += block.text;
                }
            }
        }
        if (evt.type === "result" && typeof evt.result === "string") {
            resultText = evt.result;
        }
    }
    return (resultText !== null ? resultText : accumulated).trim();
}
