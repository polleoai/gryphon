# @gryphon/protect

Runtime protection layer for the Gryphon Obsidian plugin and any other host that spawns AI CLIs.

## What it does

- **HookDispatcher** — builds spawn artifacts (env vars, args, cleanup) for Claude Code, Codex, and Gemini CLIs so the host can spawn them under hook protection.
- **PermissionIPCServer** — Unix-domain socket server the spawned hook scripts connect to for classify decisions.
- **Hook scripts** — six standalone Node scripts (PreToolUse, PostToolUse, SessionStart, SessionEnd, UserPromptSubmit, Notification) that the spawned CLIs run on tool events.
- **Attack detector + permission gate** — pre-classify tool calls; ask the user via modal when allow/deny isn't auto-decidable.
- **Protected pattern catalog** — paths and commands that override "auto-allow" modes (Safe / YOLO).
- **Injection-marker scanner + framing** — flags suspicious untrusted content the model is reading.

## Public API

```js
const { createProtectionContext } = require("@gryphon/protect");

const ctx = createProtectionContext({ plugin, settings });

// Spawn-time: build env + args + cleanup
const extras = ctx.prepareSpawn({ kind: "codex-cli", cwd, providerOptions });

// Classify a tool call
const decision = ctx.classify({ toolName, toolInput, toolUseId });

// Availability check
ctx.isAvailable();
```

Individual modules (attackDetector, denyCopy, hookDispatcher, etc.) are also exposed as named exports for consumers that need finer control.

## Boundary

This package owns runtime safety and depends on no LLM provider details. The runtime layer (`@gryphon/provider-runtime`) treats it as opaque — pass a context, or pass `null` for unprotected mode.
