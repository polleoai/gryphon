/**
 * CodexProvider — implements the LLMProvider contract via the OpenAI
 * `codex` CLI (Codex.app). Each `send()` spawns a fresh `codex exec`
 * (or `codex exec resume <id>`) process, parses its JSONL event stream
 * to EOF, and resolves with the final result.
 *
 * One-shot per turn: unlike claude-code (persistent stdin loop), Codex
 * exec exits after each turn. Resume threads the conversation via
 * `--resume <thread_id>` from the previous turn.
 *
 * Auth: handled by the CLI itself (`codex login`). The provider never
 * touches credentials. If the user isn't logged in, the CLI exits
 * non-zero with an explanatory stderr message which we surface verbatim.
 *
 * Sandbox: Codex's own sandbox handles tool execution (file read/write,
 * shell). We map Gryphon's permissionMode → Codex's sandbox mode rather
 * than wiring Gryphon-side enforcement. This is a documented trade-off:
 * the 27-event hook surface that gives `claude-code` Gryphon's two-axis
 * security has no equivalent here. Users who need Gryphon-enforced
 * protected-pattern rules should choose claude-code or one of the SDK
 * adapters instead.
 *
 * Event stream (JSONL on stdout):
 *   { type: "thread.started", thread_id: "<uuid>" }
 *   { type: "turn.started" }
 *   { type: "item.started",   item: { id, type, ... } }       — tool invocations
 *   { type: "item.completed", item: { id, type, text? } }     — agent_message holds final text
 *   { type: "turn.completed", usage: { input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens } }
 */
export {};
