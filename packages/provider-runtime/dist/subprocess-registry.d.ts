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
type SpawnOptions = Record<string, unknown>;
interface RegistryEntry {
    child: any;
    label: string;
    pgid: number | null;
    startedAt: number;
}
declare const _registry: Map<number, RegistryEntry>;
/**
 * Soft diagnostic threshold. Normal operation keeps ≤ a couple of live
 * children (claude-code reuses one persistent process; codex/gemini are
 * one-shot and exit at turn end). Crossing this almost certainly means a
 * leak regression, so we log — but we do NOT kill live requests to honor
 * a synthetic cap (correctness over a count). The real bound comes from
 * terminate-on-request-end + reuse + shutdown reaping.
 */
declare const LIVE_COUNT_WARN_THRESHOLD = 16;
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
declare function killProcessTree(child: any, signal?: NodeJS.Signals | number): void;
/**
 * Kill every tracked child tree. Used by the host's onunload and by the
 * process-shutdown handlers. Idempotent and never throws.
 */
declare function killAll(signal?: NodeJS.Signals): number;
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
declare function managedSpawn(command: string, args: string[], options?: SpawnOptions, meta?: {
    label?: string;
}): any;
/** Number of currently-tracked (presumed-live) children. For tests/diagnostics. */
declare function liveCount(): number;
export { managedSpawn, killProcessTree, killAll, liveCount, _registry, LIVE_COUNT_WARN_THRESHOLD, };
