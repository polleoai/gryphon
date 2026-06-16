# Passive-backend mode (`createPassiveSession`)

**What it's for.** Run `claude` as a *passive* LLM backend: it emits assistant turns as
structured Anthropic Messages-API content blocks (`text` + `tool_use`), and **the caller
executes the tool calls** and feeds back `tool_result` blocks. Tools are *declared* by the
caller; gryphon never runs them. This is the mode a sandboxed agent uses when it wants Claude
as a backend without surrendering its own tool routing (e.g. a `/v1/messages` proxy in front
of a containerized agent).

**How it differs from `createProvider`.** The normal `ClaudeCodeProvider` is chat-shaped: it
executes tools *inside* the host claude subprocess and aggregates everything to a single
`{text, cost, ...}` response. Passive mode keeps tool calls **structured and unexecuted** and
hands them back to you. It also runs claude clean-room: the caller's `systemPrompt` *replaces*
the default (never appends), inherited MCP servers and user/project/local settings are
skipped, and all built-in tools are denied — so the model only ever calls the tools you
declared. No `@gryphon/protect` coupling (no Obsidian system prompt, no permission-IPC).

## API

```ts
import { createPassiveSession } from "@gryphon/provider-runtime";

const session = await createPassiveSession({
  kind: "claude-code",
  cwd: "/some/neutral/path",        // REQUIRED — explicit, never process.cwd()
  model: "claude-sonnet-4-6",
  systemPrompt: "You are a backend. Follow the protocol exactly.",
  declaredTools: [
    { name: "write_file", description: "Write a file", input_schema: { type: "object", properties: { path: { type: "string" }, body: { type: "string" } }, required: ["path", "body"] } },
  ],
});

// Turn 1: claude calls a declared tool.
const r1 = await session.send({ messages: [{ role: "user", content: "Create notes.md" }] });
// r1.content     => [{ type: "text", ... }, { type: "tool_use", id, name: "write_file", input: {...} }]
// r1.stop_reason => "tool_use"   ("end_turn" for text-only turns)

// YOU execute the tool, then feed the result back. Re-supply the history; the
// session routes the trailing tool_result(s) to claude and continues the turn.
const tu = r1.content.find((b) => b.type === "tool_use");
const r2 = await session.send({ messages: [
  { role: "user", content: "Create notes.md" },
  { role: "assistant", content: r1.content },
  { role: "user", content: [{ type: "tool_result", tool_use_id: tu.id, content: "wrote 1 file" }] },
]});
// r2.stop_reason => "end_turn", r2.content => [{ type: "text", text: "Done — created notes.md." }]

await session.close();
```

`send()` accepts a per-call `signal?: AbortSignal`; the session also takes a session-level
`signal`. Aborting tree-kills the claude subprocess (and, in Phase B, its MCP shim grandchild).
`SendResponse` exposes `usage` (4 token fields), `total_cost_usd`, and `sessionId`.

### Contract & failure behavior

- **Sequential**: `await` each `send()` before the next; a concurrent `send()` is rejected.
- **Continuation**: after a `stop_reason:"tool_use"` response, the next `send()` MUST carry a
  `tool_result` for **every** parked `tool_use` (all answered in one call). A missing, unknown,
  or undeliverable `tool_result` rejects with a clear error rather than hanging.
- **Errors surface, never hang**: a CLI error `result` (rate-limit/overload/auth), a dead MCP
  transport, or claude exiting mid-turn rejects the pending `send()` — they are never laundered
  into an empty successful turn.
- **`total_cost_usd`** is `0` on `tool_use` turns (claude hasn't finished); the cumulative cost
  arrives on the terminating `end_turn` result.
- **`requestTimeoutMs?`** (optional, off by default): a per-`send()` backstop that rejects and
  tree-kills if a turn runs longer than the given ms. Leave unset for unbounded agent turns.
- **Identical parallel calls**: if the model emits two parallel `tool_use` blocks with the *same*
  tool name **and** identical input, gryphon cannot distinguish them (MCP `tools/call` carries no
  `tool_use.id`); their results are paired positionally. Distinct inputs are always correlated
  exactly.

## MCP shim architecture (Phase B)

> Phase B (full `tool_use` ↔ `tool_result` round-trip) lands via a passive MCP shim — a stub
> MCP server (claude's grandchild) that *parks* tool calls and bridges them over a unix socket
> back to the `PassiveSession`. The session resolves `send()` with the `tool_use` blocks; the
> next `send()`'s `tool_result` blocks unblock the parked call in the same live process. See
> the design spec `docs/superpowers/specs/2026-06-14-passive-backend-design.md` §6 for the
> diagram and the constraint list (C1–C15).

## Testing

- Pure units (`arg-builder`, `stream-parser`) are tested with no subprocess.
- The session is tested via a `_spawnOverride` seam that fakes the claude child.
- A live, opt-in round-trip test runs against a real `claude` subprocess when
  `RUN_LIVE_PASSIVE_TESTS=1` is set.
