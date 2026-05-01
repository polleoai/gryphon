# Gryphon — Changelog

All notable changes to the Gryphon Obsidian plugin are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning is [SemVer](https://semver.org/).

> **Project history:** This plugin was originally developed as **Hermes** through pre-1.0 milestones and was briefly published under that name at v1.0.0. It was renamed to **Gryphon** in 2026-04 to avoid confusion with the unrelated Hermes agentic system. The Gryphon v1.0.0 release is the same code as the Hermes v1.0.0 release with a name change. CHANGELOG entries below referencing "Hermes" reflect what the project was called at the time of those releases.


### Fixed

- [#14](https://github.com/polleoai/gryphon/issues/14): final fix for the multi-line ArrowUp/Down behavior introduced in v1.1.2 (#10). The mirror-element / scrollHeight heuristics tried in v1.1.2 had edge cases that flipped between two failure modes (single-line recall couldn't walk forward in history, OR multi-line per-row navigation broke). Replaced the entire scheme with a **post-frame `selectionStart` check**: don't preventDefault on ArrowUp/Down, let the browser try to move the caret, then in the next animation frame check whether `selectionStart` actually changed. Moved → native row navigation worked. Didn't move → boundary row → walk history. The browser is the only authoritative source for "where is the caret on a wrapped textarea?" — its behavior IS the answer. No mirror, no geometry math, no theme/font/cap-state dependencies. ~15 lines of logic instead of ~80. History walk fires ~16ms later than synchronously — imperceptible.


### Changed

- [#11](https://github.com/polleoai/gryphon/issues/11): `/context` is now a structured system bubble with full information density: used + remaining tokens (both K-counts and percentages), headroom to the 80% warning threshold, headroom to the 95% auto-compact threshold (SDK) or CC's auto-compact line, message counts, and a phase-appropriate options list. Previous one-line status flash is replaced.
- Context-meter button tooltip now shows **both** framings — `Context: 32K used · 168K remaining (16% of 200K)` — so users see used and remaining at a glance without typing /context. The displayed % stays "used" (rising) for consistency with the meter color thresholds and the v1.1.0 design.


### Fixed

- [#10](https://github.com/polleoai/gryphon/issues/10): chat-input ArrowUp/ArrowDown now respects soft-wrapped and pasted multi-line content. Initial implementation used mirror-element geometry; final architecture (post-frame `selectionStart` check) lands in v1.1.4.


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


---

This is the first public release. Subsequent releases will be added
above as they ship.
