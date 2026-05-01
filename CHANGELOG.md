# Gryphon — Changelog

All notable changes to the Gryphon Obsidian plugin are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning is [SemVer](https://semver.org/).

> **Project history:** This plugin was originally developed as **Hermes** through pre-1.0 milestones and was briefly published under that name at v1.0.0. It was renamed to **Gryphon** in 2026-04 to avoid confusion with the unrelated Hermes agentic system. The Gryphon v1.0.0 release is the same code as the Hermes v1.0.0 release with a name change. CHANGELOG entries below referencing "Hermes" reflect what the project was called at the time of those releases.

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

