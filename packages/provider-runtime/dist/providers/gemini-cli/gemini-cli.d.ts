/**
 * GeminiCliProvider — implements the LLMProvider contract via the
 * Google Gemini CLI (`@google/gemini-cli`). Each `send()` spawns a
 * fresh `gemini -p ... -o stream-json` process, parses its JSONL
 * event stream to EOF, and resolves with the final result.
 *
 * One-shot per turn (like CodexProvider, unlike claude-code's
 * persistent stdin loop). Resume threads the conversation via
 * `--resume <session_id>` from the previous turn.
 *
 * Auth: Gemini CLI requires either GEMINI_API_KEY in env or a
 * settings.json. We pass `settings.googleApiKey` (the same key the
 * google-api SDK provider already uses) into the spawn env as
 * GEMINI_API_KEY. If the key is empty the spawn will exit non-zero
 * with the CLI's own error message, surfaced to chat-view.
 *
 * Sandbox / approval: Gemini CLI has its own approval-mode system
 * (default | auto_edit | yolo | plan). Gryphon's permissionMode is
 * mapped to the closest CLI mode rather than wiring Gryphon-side
 * enforcement — see security trade-off documented in CodexProvider.
 *
 * Event stream (JSONL on stdout):
 *   { type: "init",        timestamp, session_id, model }
 *   { type: "message",     timestamp, role, content, delta? }
 *   { type: "tool_use",    timestamp, tool_name, tool_id, parameters }
 *   { type: "tool_result", timestamp, tool_id, status, output, error? }
 *   { type: "error",       timestamp, severity, message }
 *   { type: "result",      timestamp, status, stats: { input_tokens, output_tokens, total_tokens, cached, duration_ms, ... } }
 */
export {};
