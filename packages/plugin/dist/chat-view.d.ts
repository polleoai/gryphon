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
 *   - claudeCodeScope      — { inheritUserConfig, settingSources, mcpServers,
 *                            includeProjectMcp, autoMemory, pluginDirs,
 *                            memoryFiles } — which Claude Code config a
 *                            claude-code chat launches with (issues #25,
 *                            #27; default: no settings files from the vault
 *                            or the user, approved vault MCP servers only).
 *                            When supplied — ANY field — it REPLACES the
 *                            user's Settings → Advanced toggle (the toggle
 *                            isn't merged in). Each field the consumer
 *                            leaves unset takes the provider default on its
 *                            own: `{ memoryFiles: [...] }` behaves exactly
 *                            like no scope on every other field.
 *                            `pluginDirs` (→ --plugin-dir) must be trusted
 *                            dirs from the consumer's own install;
 *                            `memoryFiles` (→ one
 *                            --append-system-prompt-file, @-imports
 *                            expanded) carries the vault CLAUDE.md, which
 *                            the default no longer loads. Object-form `mcpServers` are
 *                            executed WITHOUT approval: build them from your
 *                            plugin's own code, never from files inside the
 *                            vault. Vault `.mcp.json` servers run only once
 *                            the user approves them. Ignored by every
 *                            provider except claude-code. See provider-runtime
 *                            providers/claude-code/scope.ts.
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
 *   - securityOverrides    — issue #29. Capability constraints from the
 *                            consumer's own code, keyed by the closed set
 *                            of weakening keys (protectedMode,
 *                            permissionMode, …). They win over this
 *                            machine's confirmed values. Weakening values in
 *                            the host's settings object are SUGGESTIONS, not
 *                            inputs: until the user confirms them on this
 *                            machine (toolbar, Settings, the one-time
 *                            prompt), protections stay on.
 *   - securityHostId       — issue #29. The store namespace when the host
 *                            has no `manifest.id`.
 *
 * This file knows nothing about any specific consuming plugin's domain.
 * All coupling comes through the options bag; consumers wire their own
 * behavior via autocompleteSources, stopStreamingHooks, onBeforeSend.
 */
export {};
