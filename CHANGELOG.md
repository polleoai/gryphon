# Gryphon — Changelog

All notable changes to the Gryphon Obsidian plugin are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning is [SemVer](https://semver.org/).

> **Project history:** This plugin was originally developed as **Hermes** through pre-1.0 milestones and was briefly published under that name at v1.0.0. It was renamed to **Gryphon** in 2026-04 to avoid confusion with the unrelated Hermes agentic system. The Gryphon v1.0.0 release is the same code as the Hermes v1.0.0 release with a name change. CHANGELOG entries below referencing "Hermes" reflect what the project was called at the time of those releases.

## [1.4.2] — 2026-05-08

### Fixed

- **Cross-provider flag drops are now visible in DevTools.** When `extraProcessArgs` flags belonging to a different provider get filtered out, the resulting log line uses `console.error` instead of `console.warn`. DevTools hides `warn`-level messages by default but shows `error`, so a consumer plugin's silently-no-op'd `--allowedTools` is no longer silent.
- **`extraProcessArgsByProvider` typoed keys now warn loudly.** A consumer plugin that wrote `claude_code` (underscore) or `claudeCode` (camel) instead of the correct `claude-code` used to silently no-op for every spawn. The chat view now validates keys at construction and logs a `console.error` for any unknown provider key.
- **Settings → Connection timeout: out-of-range input no longer silent.** Typing a number outside the 5–600 range used to be ignored without feedback. A status line below the field now shows the validation result (`✓ Override active: 90s` / `✗ Invalid: must be 5–600 seconds. Currently using: 60s`) and the effective timeout in real time.
- **`saveSettings` resilient to a listener that throws.** A buggy listener subscribed to `gryphon:settings-changed` could previously reject `saveSettings`, surfacing a "settings save failed" toast even though the persisted data was already on disk. The trigger is now wrapped in `try/catch`; the listener exception is logged but does not propagate.
- **Settings reactive surface logs API drift.** If a future Obsidian release renames `app.workspace.trigger`, the silent guard used to absorb the change and quietly stop refreshing badges. The guard now logs a `console.error` for the "API surface drifted" case while staying silent in headless test environments.

### Internal (no user-visible impact)

- **`extra-args-filter` now recognizes the `--flag=value` inline form.** A self-review pass caught that `--allowedTools=Bash,Read` was previously treated as one unknown token and slipped through to non-Claude providers. The filter now splits on `=` to extract the flag name before classification.
- **Misleading comment in `factory.js`** about the per-provider `extraArgs` filter clarified — the filter is a safety net that applies to BOTH the legacy bucket and `extraProcessArgsByProvider`, not just the legacy one.

### Compatibility

- **Test count**: 1047 (v1.4.1) → 1052 (this release).
- **Build size**: 1229.6 KB → 1231.0 KB.
- **No breaking changes**: all changes are observability + resilience improvements.

## [1.4.1] — 2026-05-08

### Fixed

- **Cross-provider flag leakage no longer breaks non-Claude spawns** ([#39](https://github.com/polleoai/gryphon/issues/39)): when a consuming plugin passed Claude-Code-only flags (e.g. `--disable-slash-commands`, `--allowedTools`, `--append-system-prompt`) via `extraProcessArgs`, switching the active provider to Codex CLI or Gemini CLI used to fail the spawn with "unexpected argument." Each provider now filters out flags that belong to other providers before spawning, with a one-line warning so consumers see what was dropped. The Claude Code provider keeps Claude-only flags; Codex / Gemini drop them.
- **Toolbar badges now refresh when settings change** ([#40](https://github.com/polleoai/gryphon/issues/40)): the model / effort / permission badges used to keep showing the value that was active when the chat panel was first opened. Switching provider or model in Settings — whether from Gryphon's own Settings tab or from a consumer plugin's settings tab — now updates all three badges immediately. No more "reload Obsidian to see the right model" workaround.

### Added

- **`extraProcessArgsByProvider` option for clean per-provider arg routing**: alongside the legacy `extraProcessArgs` (which now filters cross-provider flags), consuming plugins can pass `extraProcessArgsByProvider: { 'claude-code': [...], 'codex-cli': [...], 'gemini-cli': [...] }`. Each provider receives only its own bucket — no filtering needed because each entry is already addressed to the right provider. Recommended path for new consumer integrations.
- **`gryphon:settings-changed` workspace event**: every `plugin.saveSettings()` now fires this event after persisting. Consumer plugins that maintain their own settings-derived state can subscribe to invalidate their caches automatically instead of detaching/reopening views.

### Compatibility

- **Test count**: 1029 (v1.4.0) → 1047 (this release).
- **Build size**: 1227.0 KB → 1229.6 KB.
- **No breaking changes**: `extraProcessArgs` continues to work for existing consumers (with the new cross-provider filter making it safer in mixed-provider setups). The `gryphon:settings-changed` event is additive.

## [1.4.0] — 2026-05-07

### Added

- **Configurable connection timeout** ([#38](https://github.com/polleoai/gryphon/issues/38)): the "wait for first token" budget is now model-adaptive — Haiku 30 s, Sonnet 60 s, Opus 120 s, Opus 1M 180 s; non-Anthropic providers stay at 60 s. Resolves false-abort cases on Opus 1M and other slow-cold-start configurations where the previous fixed 60 s deadline aborted before the model produced its first token.
- **Connection timeout override setting**: new "Connection timeout (seconds)" field under Settings → Gryphon. Leave empty to use the model-adaptive default; set 5–600 to override for slow networks or unusually large prompts. Out-of-range values are silently ignored to avoid noisy mid-typing errors.

### Changed

- **Connection-timeout error bubble surfaces the actual elapsed time** and points users at the new setting in addition to suggesting a faster model. Previous wording blamed the model and offered no actionable recourse to users who specifically wanted a slower-cold-start model.

### Internal (no user-visible impact)

- Build pipeline simplified for downstream consumers. Gryphon now publishes through tagged releases only; consumer projects pull released tags via standard git submodule semantics rather than receiving silent overlays from the dev tree. Improves reproducibility for downstream builds and removes a class of cross-repo drift.

### Compatibility

- **Test count**: 1017 (v1.3.1) → 1029 (this release).
- **Build size**: 1225.6 KB → 1227.0 KB (resolver code).
- **No breaking changes**: existing settings carry forward; the new `connectionTimeoutMs` field defaults to `null` (use model-adaptive default).

## [1.3.1] — 2026-05-06

### Added

- **`/new` command** ([#28](https://github.com/polleoai/gryphon/issues/28)): clear the conversation context for the next message without losing the visible chat. Lets you switch Provider mid-thread without forwarding earlier turns to a different vendor — useful for privacy boundaries (separate Anthropic vs. OpenAI work in one session) and for starting clean when the model has gone off-track. Visible bubbles stay; only the seed sent to the next model is trimmed at the marker. Renders as a thin centered divider.
- **Status notice on Provider change** ([#29](https://github.com/polleoai/gryphon/issues/29)): when you switch Provider in Settings, a one-line notice flashes naming the new provider and reporting how many prior turns will be sent forward as context. Run `/new` to start clean. When the conversation is too long for the cap, the notice also tells you exactly how many older turns are dropped.
- **Auto-retry on rate limit** ([#34](https://github.com/polleoai/gryphon/issues/34)): new Settings toggle. When on AND the rate-limit response includes a precise retry-after delay (≤ 60 s), Gryphon automatically resubmits your prompt once after the window expires. Off by default — automatic retries can pile up unintended cost on metered APIs. Per-day quotas (8-hour-plus cooldowns) are never auto-retried; you decide.

### Changed

- **Conversation cap scales with the model's context window** ([#30](https://github.com/polleoai/gryphon/issues/30)): Provider switches and reloads previously capped seed history at the last 100 turns regardless of model. Gryphon now scales the cap with each model's actual window — 200K models stay at 100, Opus / Sonnet 1M get 500. Power users on long-running threads keep more context after Provider switches.
- **Friendlier message when a turn ends without text**: instead of the bare phrase "No response requested." (an internal placeholder from the underlying CLI), the bubble now explains what happened — tool-only turn, very short prompt, or aborted stream — and points at `/context` for state.
- **Cold-start is faster for single-provider users** ([#26](https://github.com/polleoai/gryphon/issues/26)): provider SDKs are now loaded only when their respective branch fires. A user on Claude Code only doesn't pay the parse cost for the OpenAI + Gemini SDKs they don't use.

### Fixed

- **Rate-limit messages preserve your typed prompt** ([#34](https://github.com/polleoai/gryphon/issues/34)): when a send fails with a rate-limit, your original text is restored to the input box for one-keystroke retry. No more re-typing.
- **Aborted prompts stay reachable via up-arrow** ([#36](https://github.com/polleoai/gryphon/issues/36)): a prompt whose response timed out, errored, or was stopped no longer vanishes from up-arrow recall on next reload. Aborted prompts are exactly the ones you want to retry.
- **Context window measurement no longer over-counts on tool-heavy turns** ([#31](https://github.com/polleoai/gryphon/issues/31)): SDK providers used to sum input tokens across all tool-use iterations of a single turn. Each iteration's count already includes the full history at that point, so summing produced 3-5× over-counts on agentic turns and triggered auto-compact long before the real window was full. Fixed: context measurement uses the last iteration's input count (the true window occupancy); cost still uses the cumulative sum (every API call bills for its own input re-send).
- **Deny notices keep the model's prior text in view** ([#32](https://github.com/polleoai/gryphon/issues/32)): when the model emitted a summary, called a denied tool, then quoted the deny copy, the bubble used to show only the deny text — wiping the summary you'd just read. Both are now preserved in the bubble.
- **Repeated protected-command attempts always show the modal** ([#33](https://github.com/polleoai/gryphon/issues/33)): a third attempt at the same blocked command (after two prior denies) used to skip the approve / deny modal and show the deny notice directly. Fixed: the modal fires every time, regardless of how many times the same command has been tried.
- **Internal context block no longer leaks into your bubble** ([#35](https://github.com/polleoai/gryphon/issues/35)): chat-history sometimes rendered the internal "active file" context wrapper inside user bubbles after restart. Added defenses at every read, write, and render path so the wrapper never appears in the user's view, regardless of when the chat was created. Existing chat-history files are migrated automatically on first load.

### Compatibility

- **Test count**: 950 (v1.3.0) → 1016 (this release).
- **Build size**: 1217.5 KB → 1225.6 KB (slight growth from new behaviors and defensive paths).
- **No breaking changes**: existing settings, chat-history, and provider configs carry forward without action.

## [1.3.0] — 2026-05-04

### Added

- **HookDispatcher architecture**: single shared dispatcher (`src/providers/shared/hook-dispatcher.js`) wires Gryphon's PreToolUse / BeforeTool gate into every CLI provider through a small per-provider adapter (`hook-adapters/{claude-code,codex-cli,gemini-cli}.js`). One IPC server, one classify path, one modal, one session-cache, three adapters. See `docs/adr/0005-hook-dispatcher.md` for the architecture, adapter contract, and how-to-add-a-new-provider guide.
- **Codex CLI provider** (real, not stub): full SDK-parity hook gating via Codex CLI v0.117+'s PreToolUse hook system. Codex's own sandbox + Gryphon's gate compose without redundancy.
- **Gemini CLI provider** (real, not stub): same pattern via Gemini CLI's BeforeTool / AfterTool events. `--approval-mode yolo` is forced when hooks are wired so the full tool palette stays available headlessly; the hook is the authoritative gate.
- **Cross-platform spawn safety**: new `src/providers/shared/win-spawn.js` replaces `shell:true` for `.cmd`/`.bat` shims with `cmd.exe /d /s /c <quoted-cmdline>` + `windowsVerbatimArguments:true`. Preserves multi-line context blocks and embedded `"` characters in the system prompt. Wired into all three CLI providers.
- **Linux landlock fallback**: Codex CLI's `workspace-write` sandbox needs landlock (Linux ≥5.13). On older kernels (e.g. Debian Bullseye 5.10) the sandbox failed to initialize and every shell call returned "local command runner failed." Gryphon now detects this and falls back to `danger-full-access` automatically with a one-time console warning. The PreToolUse hook remains the authoritative gate.
- **Stale-session recovery for Codex + Gemini CLI**: when `--resume <id>` references a session whose JSONL has been wiped, Gryphon catches the error, drops the stored session id, and re-spawns fresh on the same Promise.
- **Tainted-session reset**: protected denies break the session-resume chain across all six providers (CLI + SDK) so subsequent retries always re-trigger the gate instead of model echoing the prior deny verbatim.
- **Universal canonical deny copy**: single source of truth in `src/providers/shared/deny-copy.js` produces the same descriptive deny text across every provider. Operation description adapts: `deletion of <path>` for `rm`/`del`/`erase`/`unlink`/`shred`/`rmdir` (with optional `sudo`), `write to <path>` / `edit of <path>` for file mutations, `execution of <command>` for other shell.
- **Chat-view rendering normalizers** (universal across all six providers): `_collapseSummaryDrafts`, `_separateCanonicalBlocks`, `_dedupeConsecutiveParagraphs`, `_buildPostDenyClarifierBlock`, `_buildCompoundReminderBlock`. Counters small-model tendencies to skip the safe sub-task on compound prompts, rationalize repeat prompts as "system noise," or emit duplicate paragraphs.

### Changed

- **Permission-gate cache policy**: protected operations no longer cache in either direction. Every retry shows the modal so the user is the explicit decision-maker each time.
- **Tool-status normalization**: SDK snake_case tool names (`read_file`, `run_shell_command`, etc.) now map through the same alias table the classifier uses, so the toolbar status renders friendly natural-language labels regardless of which provider emitted them.
- **UI polish**: bubble prefix changed from Unicode `❯` to ASCII `>` for universal Linux font compatibility. Removed `border-bottom` on assistant bubbles and hidden `<hr>` inside assistant bubbles (Claude `---` separators were rendering as visible solid lines).

### Fixed

- **Windows spawn argv corruption**: embedded `"` characters in Gryphon's system prompt prematurely closed cmd.exe's wrapper quote, causing ENOENT on every Codex / Gemini / Claude Code spawn. Fixed by routing through `wrapForCmdShim`.
- **Gemini CLI rate-limit dump**: 429 responses arrived as raw JSON dumps in the chat bubble. Now normalized via `_formatRateLimitMessage` into a friendly form that distinguishes per-day cap exhaustion from per-minute throttling.
- **Up-arrow recall leak**: `_stripContextBlock` was single-pass; with multiple reminder blocks firing, the second + third blocks leaked into the user-visible bubble. Now iterates until stable.
- **Trailing `Command:` echo scrubber**: regex updated to fence-aware multi-line so heredocs / `python -c` blocks don't leak into chat.
- **Hook-adapter partial-write rollback**: `_createCodexHomeOverlay` and `_writeSettingsFile` paths now roll back the first artifact when the second write fails, preventing tmpdir leaks.

### Compatibility

- **Cross-platform full pass**: macOS + Windows + Linux all six providers (Claude Code CLI, Codex CLI, Gemini CLI, Anthropic API, OpenAI API, Google API) verified end-to-end. Linux requires the landlock fallback for kernels <5.13.
- **Test count**: 562 (pre-v1.3) → 950 (this release).
- **Build size**: 1217.5 kb (slight growth from new providers + normalizers).

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

