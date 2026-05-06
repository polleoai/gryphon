# ADR 0005 — HookDispatcher: a shared CLI hook orchestrator

**Status**: Accepted (2026-05-04)
**Context window**: v1.3 release — Codex CLI and Gemini CLI moved from "stub-only" to real hook-gated providers; Claude Code's existing hook-spawn glue refactored to share the new path.

## Context

Gryphon ships three CLI providers — Claude Code, Codex CLI, Gemini CLI — and three SDK providers — Anthropic, OpenAI, Google. The SDK providers gate tool calls inline (call `permission-gate.checkPermission` before executing) because they own the dispatcher. The CLI providers don't own the tool dispatcher; the CLI binary does. To gate CLI tool calls, Gryphon needs to install the CLI's own pre-tool hook system.

Each CLI exposes a different hook contract:

| CLI | Hook config | Hook event names | Output dialect |
|---|---|---|---|
| Claude Code | `--settings <path>` to a JSON file | `PreToolUse` / `PostToolUse` / `SessionStart` / `SessionEnd` / `UserPromptSubmit` / `Notification` | `{ hookSpecificOutput: { permissionDecision, permissionDecisionReason, hookEventName } }` |
| Codex CLI | TOML in `<CODEX_HOME>/config.toml` | identical to Claude Code (`PreToolUse` etc. — Codex copied the protocol) | identical to Claude Code |
| Gemini CLI | JSON in `<GEMINI_CLI_SYSTEM_SETTINGS_PATH>` | `BeforeTool` / `AfterTool` / `BeforeAgent` / `SessionStart` / `SessionEnd` / `Notification` | flat `{ decision, reason }` (no `hookSpecificOutput` envelope; `decision` uses `ask_user` instead of `ask`) |

Plus per-CLI environmental specifics: Codex needs an `auth.json` symlink so login state survives the per-spawn `CODEX_HOME` overlay. Gemini's hook timeouts are in **milliseconds**, not seconds. Each spawn needs different env vars, working directory, sandbox flags. On Windows, `.cmd` shims need a custom spawn wrap that avoids `shell:true` (newline truncation, embedded `"` corruption).

A naïve approach — duplicate the spawn-wiring code in each provider — failed in practice during early v1.3 development. Drift accumulated: one provider got a stale-session recovery path, another didn't; Windows shim handling landed in two providers but not the third; the IPC server was started three different ways. Each new fix had to be applied three times by hand, and one of the three was always missed.

## Decision

Centralize hook orchestration in a **single shared dispatcher** with **per-provider adapters**.

```
                    ┌─────────────────────────────────┐
                    │  plugin.js                      │
                    │    - boots IPC server           │
                    │    - exposes _handleClassifyRequest
                    │    - exposes _taintedSessions   │
                    └─────────────┬───────────────────┘
                                  │
            ┌─────────────────────▼─────────────────────┐
            │ src/providers/shared/hook-dispatcher.js   │
            │   prepareSpawn({ kind, plugin, options }) │
            │     1. pre-flight checks                  │
            │     2. dispatch to the right adapter      │
            │     3. return { ok, env, args, cleanup }  │
            └────┬────────────┬──────────────┬──────────┘
                 │            │              │
   ┌─────────────▼─┐  ┌───────▼─────────┐  ┌─▼──────────────┐
   │ claude-code   │  │ codex-cli       │  │ gemini-cli     │
   │  adapter      │  │  adapter        │  │  adapter       │
   │ (JSON         │  │ (TOML config +  │  │ (JSON settings │
   │  settings via │  │  CODEX_HOME     │  │  via env var,  │
   │  --settings)  │  │  overlay)       │  │  ms timeouts)  │
   └───────────────┘  └─────────────────┘  └────────────────┘
                            │  ▲
                  shared    │  │  shared
                  hook ─────┘  └───── system-prompt-hints
                  scripts            (single source of
                  (pretool.js etc.)   truth for forbidden
                                      phrase + canonical
                                      copy)
```

### The dispatcher's contract

```js
// src/providers/shared/hook-dispatcher.js
function prepareSpawn({ kind, plugin, options }) {
  // 1. Pre-flight: IPC server listening? plugin dir resolvable?
  //    real `node` binary findable? hooks fundamentally enable-able?
  // 2. Look up the adapter for this `kind` in the registry.
  // 3. Call adapter.buildSpawnExtras(plugin, options).
  // 4. Return { ok, env, args, cleanup, degradationReason }.
  //    - env: env-var overlay to pass to child_process.spawn
  //    - args: extra argv (most CLIs are env-only; Claude Code
  //      uses --settings <path>)
  //    - cleanup: a callback that removes whatever tmp files
  //      the adapter wrote; the provider calls this in
  //      _handleClose / _handleProcessError
  //    - degradationReason: when ok: false, why (so the caller
  //      can console.warn before falling through to no-hooks)
}
```

### The adapter contract

Each adapter exports:

```js
const KIND = "codex-cli" | "gemini-cli" | "claude-code";
function buildSpawnExtras(plugin, options) {
  // Return { env, args, cleanup, hookSettingsFile? }.
  // The dispatcher merges these into the spawn shape
  // the provider passes to child_process.spawn.
}
```

Adapters own:
- Their CLI's hook config format (TOML / JSON / `--settings` argv)
- Their CLI's session-state symlinks (Codex's auth.json, Gemini's tmp dir)
- Their CLI's hook event names (PreToolUse vs BeforeTool)
- Their CLI's timeout unit conversions (Gemini's ms vs everyone-else's s)
- Their CLI's tmp-file lifecycle (write, return cleanup callback)

The hook scripts themselves (`hooks/pretool.js`, `hooks/posttool.js`, etc.) are reused unchanged across all three CLIs. The wire protocol differences are reconciled by `GRYPHON_HOOK_DIALECT=gemini` env-var, which the hook script reads to decide between Claude-shape and Gemini-shape output.

### Why this shape

1. **Drift suppression**: every adapter writes hook config into a tmp file via the same `_writeSettingsFile` helper, returns a `cleanup` callback the same way, follows the same pre-flight gate. New requirements (e.g. landlock fallback, win-spawn) land in ONE place rather than three.
2. **Testability**: each adapter is a pure `(plugin, options) → { env, args, cleanup }` function. Unit tests assert the correct hook config without spawning a child process. Cross-cutting tests in `tests/hook-dispatcher.test.js` lock in the dispatcher → adapter contract.
3. **Provider independence**: the providers (`codex-cli/codex-cli.js` etc.) own the JSONL parsing, supersede semantics, finalize lifecycle. They call `dispatcher.prepareSpawn` once per send and otherwise know nothing about hooks. Adding a fourth CLI provider ships ONLY a new adapter + new event-parser; the existing dispatcher / hook scripts / IPC server / classify path / modal are untouched.
4. **Security parity**: the IPC server, classify path, modal, session cache, tainted-session reset, post-deny clarifier — every security-critical surface is shared. No "Claude Code has X but Codex doesn't."

## How to add a new provider

If a future CLI ships hook support, here's the minimal patch set:

### 1. Author an adapter under `src/providers/shared/hook-adapters/<kind>.js`

Required exports:

```js
const KIND = "<kind>";

/**
 * @param {Plugin} plugin — the running Gryphon plugin instance.
 *   Use plugin.absolutePluginDir() for the hook scripts dir,
 *   plugin.ipcServer.getSocketPath() for the IPC socket,
 *   plugin.settings for user-configured paths.
 * @param {object} options — provider's spawn options.
 * @returns {{ env, args, cleanup, hookSettingsFile? }}
 *   env:           env-var overlay merged into child_process.spawn env
 *   args:          extra argv (often empty if config is env-only)
 *   cleanup:       () => void — removes any tmp files this adapter wrote
 *   hookSettingsFile: optional, path to the config file (for diag log)
 */
function buildSpawnExtras(plugin, options) { /* ... */ }

module.exports = { KIND, buildSpawnExtras };
```

If the CLI's hook output dialect differs from Claude Code's (Gemini's flat `{decision, reason}` vs CC's `{hookSpecificOutput}`), set the dialect env var: `env.GRYPHON_HOOK_DIALECT = "gemini"`. The shared hook scripts read this and adjust output shape accordingly.

If the CLI needs a Windows-specific spawn wrap (`.cmd` shim), the provider — NOT the adapter — calls `winSpawn.wrapForCmdShim` at spawn time. Adapters don't deal with shims.

### 2. Register the adapter in `src/providers/shared/hook-adapters/index.js`

```js
module.exports = {
  "claude-code": require("./claude-code"),
  "codex-cli":   require("./codex-cli"),
  "gemini-cli":  require("./gemini-cli"),
  "<kind>":      require("./<kind>"),
};
```

### 3. Implement the provider class under `src/providers/<kind>/<kind>.js`

The provider:
- Parses the CLI's JSONL stream (or whatever the CLI emits) and translates events to the common callback shape (`onMessage`, `onTool`, `onError`, `onDone`, `onSessionExpired`).
- Calls `dispatcher.prepareSpawn({ kind: "<kind>", plugin, options })` once per send.
- Merges the returned `env` + `args` into its spawn options.
- Invokes the returned `cleanup` callback in `_handleClose` and `_handleProcessError`.
- Implements stale-session recovery if the CLI's `--resume <id>` can fail when the JSONL is gone (mirror `CodexProvider._handleStaleSession`).
- Implements tainted-session reset before `--resume`: call `plugin.consumeTaintedSession(rawId)` and clear the stored id if true.
- Calls `winSpawn.wrapForCmdShim(...)` on Windows `.cmd` shims.

### 4. Wire the provider into the factory

`src/providers/factory.js` returns the right provider for the user's selected `provider` setting. Add a branch for the new kind.

### 5. Tests

- `tests/<kind>-event-parser.test.js`: pure unit tests for the JSONL → callback translation.
- `tests/<kind>-hook-adapter.test.js`: assert the adapter writes the right hook config + returns a working cleanup callback.
- Optionally extend `tests/hook-dispatcher.test.js` with a smoke test that the dispatcher routes `kind: "<kind>"` to the new adapter.

### 6. Adapter-specific gotchas to consider

- **Auth file preservation**: if the CLI keeps a long-lived auth file on disk that the per-spawn config-overlay would mask, symlink it through (see Codex's `PRESERVED_FROM_REAL_HOME`). Keep this list MINIMAL — every additional symlink risks contention with the user's interactive-CLI use.
- **Timeout units**: spec the CLI's hook-timeout unit (s vs ms) and convert in the adapter.
- **Session resume failures**: pattern-match the CLI's "session not found" error in the provider's `_handleClose` and trigger stale-session recovery.
- **Sandbox interactions**: if the CLI has its own sandbox layer, document the security-trade-off for the case where Gryphon's hook is the only gate (see Codex's landlock fallback in `_supportsLandlockSandbox`).

## Consequences

### Positive

- **One place to fix bugs**: when QA found that hook-adapter partial writes leaked tmp files (QA-V13H-A), the fix landed in both Codex and Gemini adapters via the same try/catch/rollback pattern. Drift impossible.
- **One place for new features**: tainted-session reset, post-deny clarifier, win-spawn handling — all shipped once and applied universally.
- **Predictable extension cost**: adding a fourth CLI is a known scope (~3 files + tests), not an unknown integration project.
- **Security uniform**: no "we hardened CC but didn't hardened Codex/Gemini." Every CLI shares the same gate, modal, cache, and reset semantics.

### Negative

- **One layer of indirection**: providers no longer write `--settings <path>` directly; they call `dispatcher.prepareSpawn`. Reading the spawn flow requires hopping through the dispatcher to the adapter to find what gets passed. Mitigated by the simple, single-purpose dispatcher and short adapter files.
- **Adapter-contract enforcement**: the dispatcher trusts adapters to return well-formed `{ env, args, cleanup }` — bad adapters can corrupt other providers' overlays via env-var collisions. Mitigated by adapter unit tests and the namespaced env-var convention (`GRYPHON_*`, `CODEX_HOME`, `GEMINI_CLI_SYSTEM_SETTINGS_PATH` — no overlap).
- **Single point of failure**: a bug in the dispatcher's pre-flight checks would degrade hooks for all three CLIs simultaneously. Mitigated by the dispatcher being small (≤200 lines) and well-tested.

### Neutral

- **The hook scripts** (`hooks/pretool.js` etc.) are NOT moved into the dispatcher; they remain standalone Node scripts spawned by the CLI. The dispatcher's job is to wire each CLI's hook-config to point AT them — not to embed them.

## Related ADRs

- ADR 0001: Command Classifier boundary — defines the contract the hook scripts call into via IPC.
- ADR 0002: Provider integration strategy — explains why we hand-build per-provider adapters instead of using LiteLLM / Vercel AI SDK / OpenRouter.
- ADR 0003: OpenAI + Google providers — predecessor to this ADR (introduced the SDK side; this ADR adds the CLI-side parity).

## References

- Source: `src/providers/shared/hook-dispatcher.js`, `src/providers/shared/hook-adapters/`, `src/providers/{claude-code,codex-cli,gemini-cli}/`.
- Tests: `tests/hook-dispatcher.test.js`, `tests/{codex,gemini}-hook-adapter.test.js`, `tests/{codex-cli,gemini-cli}-event-parser.test.js`.
- Mid-development checkpoint notes (development-only; superseded by this ADR for the architectural narrative).
