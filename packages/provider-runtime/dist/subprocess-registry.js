"use strict";
/**
 * Subprocess registry — owns the full lifecycle of every CLI child the
 * runtime spawns (`claude` / `codex` / `gemini`), so nothing leaks.
 *
 * Why this exists (incident 2026-06-05, docs/subprocess-lifecycle-requirements.md):
 * the CLI providers spawned a child per request and never terminated it,
 * nor reaped it on plugin unload. Each `claude` additionally auto-starts
 * its own MCP-server grandchildren (it reads the vault's `.mcp.json`), so
 * every leaked `claude` dragged a tree of grandchildren — over a session
 * these accumulated without bound and orphaned (PPID 1) on Obsidian quit.
 *
 * The fix has three parts, all in this module:
 *
 *   1. **Detached process groups (POSIX).** Each child is spawned with
 *      `{ detached: true }` so it becomes its own group leader (pgid ==
 *      pid). Killing the GROUP (`process.kill(-pid, sig)`) reaps the
 *      child *and* every grandchild it spawned (the MCP servers). Killing
 *      only the `claude` pid would leave `athena.server` orphaned. On
 *      Windows we never detach (it would pop a console and our CLI shims
 *      route through cmd.exe) — instead `taskkill /T /F` walks the tree.
 *
 *   2. **A registry.** Every managed spawn is tracked by pid and removed
 *      on confirmed exit. You cannot kill what you don't track. The host
 *      (plugin onunload) and the process-shutdown handlers flush it.
 *
 *   3. **Shutdown reaping.** Installed once on first spawn:
 *      `exit` (synchronous group-kill), `beforeExit`, and one-shot
 *      `SIGINT`/`SIGTERM`/`SIGHUP` handlers that kill every tracked tree
 *      then re-raise the signal so the host's own exit path still runs.
 *
 * The module is platform-aware but otherwise host-agnostic — it has no
 * Obsidian dependency, so a non-Obsidian consumer of @gryphon/provider-runtime
 * gets the same leak-free guarantee.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const { spawn, spawnSync } = require("child_process");
const IS_WINDOWS = process.platform === "win32";
// pid → entry. A pid is registered at spawn and deleted on the child's
// `exit`/`error` event (whichever fires first).
const _registry = new Map();
let _handlersInstalled = false;
/**
 * Soft diagnostic threshold. Normal operation keeps ≤ a couple of live
 * children (claude-code reuses one persistent process; codex/gemini are
 * one-shot and exit at turn end). Crossing this almost certainly means a
 * leak regression, so we log — but we do NOT kill live requests to honor
 * a synthetic cap (correctness over a count). The real bound comes from
 * terminate-on-request-end + reuse + shutdown reaping.
 */
const LIVE_COUNT_WARN_THRESHOLD = 16;
/**
 * Kill a child process and its entire descendant tree. Idempotent: a
 * double-kill (or a kill of an already-exited child) is a no-op and never
 * throws.
 *
 *   POSIX: signal the process GROUP via the negative pid. With detached
 *          spawn the group leader's pgid == pid, so `-pid` reaches the
 *          child and every grandchild it started. ESRCH (group already
 *          gone) is swallowed; other errors fall back to a direct child
 *          kill so we at least take down the immediate process.
 *   Windows: `taskkill /T /F /PID <pid>` terminates the pid and all of
 *          its children. Best-effort; we also call child.kill() as a
 *          backstop.
 */
function killProcessTree(child, signal = "SIGTERM") {
    if (!child || child.pid == null)
        return;
    // H1: never signal a pgid/pid that may have been recycled. Node retains
    // `child.pid` after exit (it does NOT go null), so the delayed-SIGKILL
    // escalators could otherwise fire `process.kill(-pid)` against a dead
    // child's group 5s later — and on a busy host that pgid may now belong
    // to an unrelated live process tree. Once the child has exited there is
    // nothing to kill, so bail.
    if (child.exitCode != null || child.signalCode != null)
        return;
    const pid = child.pid;
    if (IS_WINDOWS) {
        try {
            // /T = tree, /F = force. Fire-and-forget; we don't await it.
            spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
        }
        catch (_) { /* taskkill missing/locked — fall through to direct kill */ }
        try {
            child.kill();
        }
        catch (_) { /* already dead */ }
        return;
    }
    // POSIX: try the whole group first (negative pid). On success we're done.
    // On ANY failure — ESRCH (group gone), EPERM, or a non-detached child that
    // never became a group leader — fall back to a direct child kill. That
    // fallback is a harmless no-op if the child is truly gone, and reaps the
    // direct pid if it's a standalone (non-leader) process.
    try {
        process.kill(-pid, signal);
        return;
    }
    catch (_) { /* fall through to the direct-child fallback below */ }
    try {
        child.kill(signal);
    }
    catch (__) { /* already dead */ }
}
/**
 * Kill every tracked child tree. Used by the host's onunload and by the
 * process-shutdown handlers. Idempotent and never throws.
 */
function killAll(signal = "SIGTERM") {
    let n = 0;
    // Snapshot first — killProcessTree triggers `exit` which mutates the map.
    for (const entry of Array.from(_registry.values())) {
        try {
            killProcessTree(entry.child, signal);
            n++;
        }
        catch (_) { /* best-effort */ }
    }
    return n;
}
/**
 * Synchronous last-resort group kill for the `exit` event, where only
 * synchronous work is allowed. POSIX uses a direct `process.kill(-pgid)`
 * (synchronous); Windows uses `spawnSync(taskkill)` (also synchronous).
 */
function _killAllSync() {
    for (const entry of Array.from(_registry.values())) {
        const child = entry.child;
        const pid = child && child.pid;
        if (pid == null)
            continue;
        // H1: skip already-exited children — their pgid may be recycled.
        if (child.exitCode != null || child.signalCode != null)
            continue;
        if (IS_WINDOWS) {
            try {
                spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
            }
            catch (_) { /* best-effort at exit */ }
        }
        else {
            try {
                process.kill(-pid, "SIGKILL");
            }
            catch (_) {
                try {
                    process.kill(pid, "SIGKILL");
                }
                catch (__) { /* already dead */ }
            }
        }
    }
}
function _installShutdownHandlers() {
    if (_handlersInstalled)
        return;
    _handlersInstalled = true;
    // Synchronous best-effort reap on any exit path. Detached groups do NOT
    // die with the parent (that's the trade-off for being able to tree-kill
    // them), so an explicit kill here is required to avoid orphans.
    process.on("exit", () => { try {
        _killAllSync();
    }
    catch (_) { /* exit must not throw */ } });
    // beforeExit allows async-ish work; SIGTERM the groups politely.
    process.on("beforeExit", () => { try {
        killAll("SIGTERM");
    }
    catch (_) { /* best-effort */ } });
    // One-shot signal handlers: reap, then re-raise the SAME signal with our
    // listener removed so the host's own exit disposition runs (we don't
    // permanently swallow Ctrl-C from a headless consumer). In the Electron
    // renderer these effectively never fire; the real path is onunload.
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
        try {
            process.once(sig, () => {
                // The host is dying via this signal → re-raising it exits the
                // process by signal, so the `exit` event (and its SIGKILL sweep)
                // will NOT run. Do the synchronous SIGKILL sweep HERE so a wedged
                // grandchild that ignores SIGTERM (exactly the daemon class in the
                // incident) can't outlive us. Then re-raise with our once-listener
                // already removed so the host's own exit disposition runs (we don't
                // permanently swallow Ctrl-C from a headless consumer).
                try {
                    _killAllSync();
                }
                catch (_) { /* best-effort */ }
                try {
                    process.kill(process.pid, sig);
                }
                catch (_) { /* host already exiting */ }
            });
        }
        catch (_) { /* signal not supported on this platform */ }
    }
}
/**
 * Spawn a child process that is tracked and reapable. Drop-in for
 * `child_process.spawn(command, args, options)` — same return value (a
 * ChildProcess) — with two additions:
 *
 *   - POSIX: `detached: true` is set by default (unless the caller already
 *     specified `detached`, or the options look like a Windows cmd-shim
 *     wrap with `windowsVerbatimArguments`). We deliberately do NOT
 *     `unref()` — the runtime OWNS these children and must keep them
 *     tracked.
 *   - The child is registered and auto-deregistered on exit.
 *
 * @param meta.label  short tag for diagnostics (e.g. "claude-code")
 */
function managedSpawn(command, args, options = {}, meta = {}) {
    _installShutdownHandlers();
    const spawnOptions = { ...options };
    // POSIX: detach into a fresh process group (pgid == pid) so killProcessTree
    // can reap the whole tree. Gate ONLY on platform + an explicit caller
    // override — do NOT inspect windowsVerbatimArguments here (it's a
    // Windows-only concern; checking it on POSIX would silently un-detach a
    // cross-platform opts object and re-leak grandchildren). Windows never
    // detaches (it would pop a console; our CLI shims route through cmd.exe)
    // — taskkill /T walks the tree there instead.
    let detached = false;
    if (!IS_WINDOWS && options.detached === undefined) {
        spawnOptions.detached = true;
        detached = true;
    }
    else {
        detached = options.detached === true;
    }
    const child = spawn(command, args, spawnOptions);
    if (child && child.pid != null) {
        const pid = child.pid;
        _registry.set(pid, {
            child,
            label: meta.label || command,
            pgid: detached ? pid : null,
            startedAt: Date.now(),
        });
        const deregister = () => { _registry.delete(pid); };
        child.once("exit", deregister);
        child.once("error", deregister);
        if (_registry.size > LIVE_COUNT_WARN_THRESHOLD) {
            console.warn(`[gryphon/subprocess-registry] ${_registry.size} live CLI subprocesses tracked ` +
                `(> ${LIVE_COUNT_WARN_THRESHOLD}). This usually signals a subprocess leak — ` +
                `children should be reaped at request end. Labels: ` +
                Array.from(_registry.values()).map((e) => e.label).join(", "));
        }
    }
    return child;
}
/** Number of currently-tracked (presumed-live) children. For tests/diagnostics. */
function liveCount() {
    return _registry.size;
}
module.exports = {
    managedSpawn,
    killProcessTree,
    killAll,
    liveCount,
    // Exposed for tests only — resets handler-install state is intentionally
    // NOT exposed (handlers are process-global and harmless once installed).
    _registry,
    LIVE_COUNT_WARN_THRESHOLD,
};
