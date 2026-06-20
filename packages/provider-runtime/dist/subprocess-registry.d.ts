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
export {};
