/**
 * GryphonChatView — core chat ItemView used by Gryphon standalone and by
 * consuming plugins that compose Gryphon's chat surface.
 *
 * Responsibilities:
 *   - Render the chat UI (toolbar, messages, status bar, input, autocomplete)
 *   - Stream responses from the active LLM provider (CLI or SDK)
 *   - Persist and restore chat history (merges local log + CLI .jsonl)
 *   - Handle plugin-level slash commands (see SLASH_COMMANDS in constants.js
 *     for the authoritative inventory) and forward everything else to the
 *     provider for its own slash-command processing
 *
 * Extension points (passed via constructor `options`):
 *   - extraToolStatus      — entries merged into the tool→status map for
 *                            custom MCP tools
 *   - extraProcessArgs     — CLI args appended to every CLI provider spawn.
 *                            Cross-provider flags are filtered (issue #39):
 *                            a Claude-only flag like --disable-slash-commands
 *                            is silently dropped before the codex-cli or
 *                            gemini-cli spawn so the spawn doesn't fail with
 *                            "unknown argument."
 *   - extraProcessArgsByProvider — { 'claude-code': [...], 'codex-cli': [...],
 *                            'gemini-cli': [...], ... } — per-provider
 *                            extra CLI args. Skips the cross-provider
 *                            filter (entries are already targeted). Use
 *                            this for clean per-provider routing instead
 *                            of relying on the filter.
 *   - onBeforeSend         — callback(text) => boolean. Return true to
 *                            "consume" a message (intercept domain-specific
 *                            commands before they reach the provider).
 *   - autocompleteSources  — array of { name, matches(text), suggest(text) }.
 *                            Core prepends a built-in slash source; consumer
 *                            sources extend it.
 *   - stopStreamingHooks   — array of hook(view) callbacks run BEFORE core
 *                            teardown in stopStreaming (for cleaning up
 *                            plugin-owned side processes).
 *   - viewType / displayText / icon — per-plugin view identity.
 *
 * This file knows nothing about any specific consuming plugin's domain.
 * All coupling comes through the options bag; consumers wire their own
 * behavior via autocompleteSources, stopStreamingHooks, onBeforeSend.
 */
export {};
