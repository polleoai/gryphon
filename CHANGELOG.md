# Gryphon — Changelog

All notable changes to the Gryphon Obsidian plugin are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning is [SemVer](https://semver.org/).

> **Project history:** This plugin was originally developed as **Hermes** through pre-1.0 milestones and was briefly published under that name at v1.0.0. It was renamed to **Gryphon** in 2026-04 to avoid confusion with the unrelated Hermes agentic system. The Gryphon v1.0.0 release is the same code as the Hermes v1.0.0 release with a name change. CHANGELOG entries below referencing "Hermes" reflect what the project was called at the time of those releases.

## [1.3.0] — 2026-05-04

### Added

- **Codex CLI provider**: native local-CLI integration alongside the existing Claude Code CLI mode. Settings → Provider now offers "Codex CLI." Same protected-pattern guardrails fire on shell and file-mutation tools as in API modes.
- **Gemini CLI provider**: native local-CLI integration. Settings → Provider now offers "Gemini CLI." Same guardrail parity.
- **Windows + Linux support across all CLI providers**: previously CLI modes were Mac-first. v1.3 adds full Windows and Linux compatibility for Claude Code CLI, Codex CLI, and Gemini CLI — protected-pattern gating, modals, and chat rendering all verified on all three platforms.
- **Stale-session recovery for Codex + Gemini CLI**: when a CLI's stored session id is no longer on disk, Gryphon transparently starts a fresh session and re-sends the user's message instead of erroring out.
- **Universal deny copy**: every provider now produces the same descriptive deny message when a protected pattern matches:
  > The Gryphon plugin is blocking the deletion of `/tmp/x.md` because it matches one of your protected patterns (destructive operation).
  >
  > To allow it:
  > - Open Obsidian → Settings → Gryphon → Protected commands
  > - Uncheck the matching pattern
  > - Ask me again

  Wording adapts to the operation kind (deletion / write / edit / execution) and surfaces the file or command name so users see exactly what was blocked.
- **Friendlier rate-limit messages on Gemini**: 429 responses no longer dump raw JSON; the new copy explains the per-day vs per-minute distinction and surfaces the matched quota dimension.
- **Optimized dispatch to different LLM models**: under-the-hood improvements unify how Gryphon talks to each provider. Result: identical guardrail behaviour, identical deny copy, identical chat polish across every model and CLI.

### Changed

- **Protected-operation modal always re-prompts**: protected operations no longer cache in either direction. Every retry of a destructive action shows the modal so the user is the explicit decision-maker each time.
- **Chat rendering polish**: duplicate paragraphs collapsed, smushed deny blocks paragraph-separated, draft summaries folded into a "Show earlier draft" disclosure when the model regenerates after a refusal. Snake_case tool names (`read_file`, `run_shell_command`) now render as friendly status labels in the toolbar instead of leaking raw identifiers.
- **UI**: bubble prefix changed from Unicode chevron to plain `>` for universal font compatibility on Linux. Cleaned up assistant-bubble borders.

### Fixed

- **Windows spawn corruption**: certain prompts containing `"` characters caused CLI spawns to fail with "The system cannot find the file specified." Fixed.
- **Up-arrow recall**: when multiple reminder blocks fired on the same turn, some leaked into the user-visible recall. Now stripped uniformly.
- **Multi-line shell echoes**: heredocs and `python -c` blocks could leak the rest of the assistant message when scrubbed. Fixed.

### Compatibility

- **Cross-platform full pass**: macOS + Windows + Linux all six providers (Claude Code CLI, Codex CLI, Gemini CLI, Anthropic API, OpenAI API, Google API) verified end-to-end. On Linux kernels older than 5.13, Codex CLI auto-falls-back to a less restrictive sandbox with a console warning (Gryphon's protected-pattern gate remains the authoritative check).
- **Test count**: 562 (pre-v1.3) → 950 (this release).

## [1.2.0] — 2026-05-02

### Added

- **OpenAI provider** ([#17](https://github.com/polleoai/gryphon/issues/17)): native SDK adapter using `openai@6.35`. Supports the GPT-5 family (gpt-5, gpt-5-mini, gpt-5.4, gpt-5.4-mini, gpt-5.5), GPT-4 family (gpt-4o, gpt-4.1), and o-series reasoning models (o3, o3-mini, o4-mini). Settings → Provider now offers "OpenAI API" alongside Anthropic and Claude Code. Tool dispatch routes through the same `executeTool` registry as Anthropic mode, so attack-detector + permission-gate guardrails fire identically across providers.
- **Google Gemini provider** ([#18](https://github.com/polleoai/gryphon/issues/18)): native SDK adapter using `@google/genai@1.51`. Supports Gemini 2.5 Pro / 2.5 Flash / 2.5 Flash-Lite (current GA tier) plus 3.x preview models. Same security parity contract as OpenAI mode. Settings → Provider offers "Google Gemini API".
- **Test key buttons** for OpenAI and Google API keys in Settings — same one-click validation flow that Anthropic already had.
- **Per-provider model dropdowns:** the chat panel toolbar's model picker and Settings → Default model both adapt to the active provider's native model list.
- **Cross-vendor aliases:** the Anthropic-style names `haiku` / `sonnet` / `opus` map to sensible counterparts on OpenAI (gpt-5-mini / gpt-5.4-mini / gpt-5.4) and Gemini (gemini-2.5-flash-lite / gemini-2.5-flash / gemini-2.5-pro).

### Fixed

- [#21](https://github.com/polleoai/gryphon/issues/21) / [#22](https://github.com/polleoai/gryphon/issues/22): the model toolbar and Settings → Defaults section showed Anthropic model labels even when Provider was non-Claude. Now provider-aware.
- [#23](https://github.com/polleoai/gryphon/issues/23): failed-send chat history was lost across plugin disable+enable when the provider was misconfigured. Two-part fix on save sessionId + welcome-panel suppression.
- [#25](https://github.com/polleoai/gryphon/issues/25): cross-provider Provider switch left a stale model id, causing the toolbar / Settings dropdown to disagree with the runtime API call. Fix: `getActiveProviderKind` helper + `_resetModelForProvider` proactive reset.
- [#27](https://github.com/polleoai/gryphon/issues/27): cross-vendor model id leak — a stale `settings.model` from a prior provider could reach the new provider's API and 400. Fix: `coerceToVendorModel(alias)` in each provider's pricing.js.
- [#24](https://github.com/polleoai/gryphon/issues/24): **silent data loss bug.** `filterMessagesForSave`'s SDK-detection check `startsWith("sdk-")` only matched the legacy anthropic-api format. OpenAI's `openai-sdk-` and Gemini's `gemini-sdk-` failed the check, classified as CLI sessions, and got their messages dropped on save. Replaced with a regex recognizing all three SDK prefixes. Reclassified from P3 latent to P0 after a user-reported wild bug confirmed real conversation turns going missing.

### Changed

- Provider dropdown labels now name only the provider (no model names) — model selection lives in its own dropdown.
- Default model in OpenAI mode: gpt-5.4-mini. In Gemini mode: gemini-2.5-flash.
- Bundle size: 374.9 KB → 1166.1 KB. The +791 KB delta is the combined weight of `openai` and `@google/genai`. Lazy-require deferral is queued for v1.3 ([#26](https://github.com/polleoai/gryphon/issues/26)).

### Test coverage

- Test count: 562 → 746 (+184).
- New test files: 6 for OpenAI (translator, pricing, streaming, tool-loop, attack-detector, mock-client stub), 6 for Gemini (same shape), plus filter regression tests covering the #24 wild bug.

## [1.1.4] — 2026-04-29

### Fixed

- [#14](https://github.com/polleoai/gryphon/issues/14): final fix for the multi-line ArrowUp/Down behavior introduced in v1.1.2 (#10). The mirror-element / scrollHeight heuristics tried in v1.1.2 had edge cases that flipped between two failure modes (single-line recall couldn't walk forward in history, OR multi-line per-row navigation broke). Replaced the entire scheme with a **post-frame `selectionStart` check**: don't preventDefault on ArrowUp/Down, let the browser try to move the caret, then in the next animation frame check whether `selectionStart` actually changed. Moved → native row navigation worked. Didn't move → boundary row → walk history. The browser is the only authoritative source for "where is the caret on a wrapped textarea?" — its behavior IS the answer. No mirror, no geometry math, no theme/font/cap-state dependencies. ~15 lines of logic instead of ~80. History walk fires ~16ms later than synchronously — imperceptible.

## [1.1.3] — 2026-04-29

### Changed

- [#11](https://github.com/polleoai/gryphon/issues/11): `/context` is now a structured system bubble with full information density: used + remaining tokens (both K-counts and percentages), headroom to the 80% warning threshold, headroom to the 95% auto-compact threshold (SDK) or CC's auto-compact line, message counts, and a phase-appropriate options list. Previous one-line status flash is replaced.
- Context-meter button tooltip now shows **both** framings — `Context: 32K used · 168K remaining (16% of 200K)` — so users see used and remaining at a glance without typing /context. The displayed % stays "used" (rising) for consistency with the meter color thresholds and the v1.1.0 design.

## [1.1.2] — 2026-04-29

### Fixed

- [#10](https://github.com/polleoai/gryphon/issues/10): chat-input ArrowUp/ArrowDown now respects soft-wrapped and pasted multi-line content. Initial implementation used mirror-element geometry; final architecture (post-frame `selectionStart` check) lands in v1.1.4.

## [1.1.1] — 2026-04-29

Slash-command parity pass ([#9](https://github.com/polleoai/gryphon/issues/9)) plus three queue-recovery bugs found in v1.1.0 testing.

### Added — slash commands

- **`/btw <text>`** — side-note context injection. Wraps the message with a "no expansion needed; reply in one sentence" preamble so the model logs the note as future context without burning tokens on a long reply. User bubble renders dimmed + italic with a "· btw" tag.
- **`/version`** — quick one-line system info: plugin version, provider, model, OS, Obsidian version.
- **`/status`** — unified session-status panel: provider, model, effort, permissions, context usage, message count, cumulative cost, auto-compact state.
- **`/doctor`** — diagnostics dump for bug reports: versions, provider availability, hook scripts present, IPC status, network reachability test.
- **`/recap`** — generate a conversation summary as a regular bubble without committing the compaction (no archive, no session reset).
- **`/init`** — scaffold `Gryphon/MANUAL.md` template if missing; opens for editing. Won't overwrite an existing file.
- **`/feedback [text]`** — modal with three options: GitHub issue (with diagnostic context prefilled), mailto contact@polleo.ai, or open issues page. Never auto-sends. Conversation content is never included unless the user pastes it.
- **`/permissions`** — added to autocomplete (was already wired as alias of `/perm`).

### Fixed — queue recovery

- [#6](https://github.com/polleoai/gryphon/issues/6): queued prompts are no longer silently lost on stream timeout / error / stop. Texts survive in up-arrow recall, and the oldest queued text is restored to the input box for one-keystroke retry.
- [#7](https://github.com/polleoai/gryphon/issues/7): `sendMessage` catch branch no longer auto-fires the next queued prompt after a visible error. The user gets a chance to react before queued sends dispatch.
- [#8](https://github.com/polleoai/gryphon/issues/8): `lastSessionId` is no longer wiped on generic abort (timeout, network error). The next message resumes the same server-side session, preserving conversation context. Only the dedicated `onSessionExpired` callback (CC's "No conversation found" stderr) wipes.

## [1.1.0] — 2026-04-28

Chat-input UX fixes (issues #2, #3, #4) and SDK auto-compact (issue #5).

### Added

- **SDK auto-compact at 95%** ([#5](https://github.com/polleoai/gryphon/issues/5)). When the conversation reaches 95% of the model's context window in Anthropic API mode, Gryphon now automatically summarizes the conversation and resets to a fresh session seeded with the summary — mirroring Claude Code's own auto-compaction in CLI mode. New `Auto-compact at 95% (SDK mode)` toggle in Settings (default on).
- **Status-line warning at 80%**. A one-shot proactive notice fires when context utilization crosses 80% (with hysteresis at 75% so it re-arms after a compact). Wording is provider-aware: SDK names Gryphon's auto-compact, CC names Claude Code's. Replaces the previous 70% one-shot.
- **Lag-failsafe**: if the SDK still returns `prompt is too long` despite our threshold check (e.g., a single tool-loop iteration ballooned history mid-turn), Gryphon now auto-compacts and retries the user's original message transparently.
- **Emergency trim**: if the auto-compact's own summary turn overflows, Gryphon drops the oldest pairs from the SDK provider's history and retries the summary once.
- **Persistent thinking blocks** ([#4](https://github.com/polleoai/gryphon/issues/4)). Extended-reasoning ("thinking") output from both providers is now captured, persisted in `chat-history.json`, and rendered as a collapsed `<details>` toggle (💭 Thinking) above each assistant response. Survives reload + Obsidian restart for both Anthropic API and Claude Code modes.
- **Type-while-streaming + queue** ([#3](https://github.com/polleoai/gryphon/issues/3)). The chat input is no longer disabled while a turn streams. Sends made during streaming render an immediate dimmed "queued" bubble and dispatch one at a time after the current turn finalizes. Stop / `_cleanupStreamingState` clears the queue.

### Fixed

- **Chat-input caret-into-view** ([#2](https://github.com/polleoai/gryphon/issues/2)). Past the 150px cap the textarea is internally scrollable; the caret now follows arrow-key / Home / End / Page navigation instead of disappearing below the visible region. Implementation uses a hidden mirror-element to measure the caret's pixel y-offset, accounting for soft-wrapped lines.

### Changed

- Context-meter button color thresholds shift to match the new policy: **warn ≥ 80%, danger ≥ 95%**. Previous thresholds (warn ≥ 50%, danger ≥ 80%) were calibrated to a manual-only compact flow.
- Manual `/compact` flow is unchanged — the auto path reuses the same machinery and skips the user-confirmation step.

## [1.0.0] — 2026-04-25

Renamed to Gryphon. Functionally identical to Hermes v1.0.0; this release is the canonical v1.0.0 going forward, with a one-step migration path for the small number of users who installed Hermes v1.0.0 in the brief window before the rename.

- All `Hermes` references in the plugin replaced with `Gryphon`: plugin id, display name, vault folder, viewType, CSS classes, log prefixes, internal constants
- Vault folder migration: existing `Hermes/` folder is auto-renamed to `Gryphon/` on first launch, preserving skills, exports, and MANUAL.md
- Settings migration: hand-copy `.obsidian/plugins/hermes/data.json` → `.obsidian/plugins/gryphon/data.json` (settings are unencrypted JSON)
- All other behavior unchanged from Hermes v1.0.0 — same security model, same providers, same hook surface, same protected patterns

