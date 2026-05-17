# Gryphon — Changelog

All notable changes to the Gryphon Obsidian plugin are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning is [SemVer](https://semver.org/).

> **Project history:** This plugin was originally developed as **Hermes** through pre-1.0 milestones and was briefly published under that name at v1.0.0. It was renamed to **Gryphon** in 2026-04 to avoid confusion with the unrelated Hermes agentic system. The Gryphon v1.0.0 release is the same code as the Hermes v1.0.0 release with a name change. CHANGELOG entries below referencing "Hermes" reflect what the project was called at the time of those releases.

## [1.6.1] — 2026-05-16

### Changed — documentation

- **README rewritten to reflect multi-provider support.** Six provider modes ship today (Anthropic API, OpenAI API, Google API, Claude Code CLI, Codex CLI, Gemini CLI) plus an Auto-detect mode, but the README's tagline + intro + Requirements + Provider Modes + Settings Reference sections all still framed Gryphon as Claude-only. Now they describe what actually ships:
  - **Tagline**: "AI chat for Obsidian. Talk to Claude, GPT, or Gemini..."
  - **Requirements**: lists all three API key options + the CLI option; user picks whichever they already have credentials for
  - **Provider modes table**: expanded from 3 entries to 7 (all six providers + Auto)
  - **Settings reference table**: expanded with OpenAI / Google / Codex / Gemini settings rows that have shipped since v1.2.0 but were never added to the README
  - **Affiliation disclaimer**: now covers Anthropic, OpenAI, and Google rather than only Anthropic
- **No code, binary, or behaviour change.** Same plugin, same features, same security guardrails. This release is purely a docs correction so the Obsidian Community Plugins directory page (which renders README.md from `polleoai/gryphon` HEAD) shows the correct multi-provider positioning to anyone discovering Gryphon in the directory.

### Compatibility

- Identical bundle, identical features, identical UI to v1.6.0. Test count: 1055 (unchanged).

## [1.6.0] — 2026-05-16

This release closes out Gryphon's Obsidian Community Plugins compliance work. v1.5.2 fixed the directory's automated scorecard (workspace build, CSS hygiene, README disclosures); v1.6.0 finishes the loop by making the release pipeline itself first-class — every future release is built in CI with sigstore build-provenance attestations on every asset — and cleans the build-log noise that v1.5.2's pnpm-compat `.npmrc` introduced.

End-users see no behavior change. The bundle is identical, the features are identical, the UI is identical. What changed is how Gryphon ships and how it presents itself to Obsidian's automated checks.

### Added — CI release pipeline (the v1.5.2 follow-through)

- **`workflow_dispatch` trigger on the release workflow.** `.github/workflows/release.yml` now supports manual re-fires against an existing tag in addition to the automatic `push: tags:` trigger. The same code path serves both — a job-level `TAG_NAME` env resolves to `inputs.tag || github.ref_name`. Use case: when a tag-push event races the registration of a newly-introduced workflow file (GitHub's first-run timing — exactly what v1.5.2 hit), the maintainer can manually re-fire after the workflow registers. Sigstore attestation is preserved on the re-fire — no need to fall back to attestation-less local uploads.

- **`Validate TAG_NAME shape` pre-step.** Runs before checkout. Rejects any value that doesn't match `^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[A-Za-z0-9.]+)?$` — strict semver, no leading zeros (per semver.org §2 and Obsidian's tag-naming rule). Defends against (a) typos in `workflow_dispatch` inputs, (b) any regex-metachar splice into the downstream `awk` CHANGELOG extractor. Verified against 21 input cases.

- **"Release ownership" documentation block in the workflow header.** Spells out that the workflow OWNS the release body and named asset files for every tag it processes. Maintainers should not hand-edit release bodies — the next run reverts them.

### Fixed — build-log hygiene + bash quoting

- **`npm run build` is quiet again.** v1.5.2 shipped an `.npmrc` with `link-workspace-packages=true` and `prefer-workspace-packages=true` so pnpm 9.x (used by Obsidian's build-verification sandbox) could link workspace siblings locally. npm 11 doesn't recognize those keys and emitted six "Unknown project config" warnings on every install + build. v1.6.0 replaces the mechanism with `"file:../<sibling>"` entries directly in each workspace's `package.json` — both npm and pnpm honor those natively without any per-tool config. The `.npmrc` is removed.

- **`scripts/notify-athena-release.sh` no longer crashes silently.** Line 55's `"$VERSION…"` (with a literal UTF-8 ellipsis) tripped bash variable-name parsing under `set -euo pipefail`, exiting with "unbound variable: VERSION…" before the consumer-dispatch fired. Now `"${VERSION}…"` with explicit brace delimiters. End-effect: post-release Athena notifications fire correctly again.

### Changed — release-pipeline ergonomics

- **`scripts/cut-public-release.sh`** post-push instructions now recommend `gh workflow run release.yml -f tag=<version>` as the primary fallback when the auto-fire doesn't run (preserves CI build + sigstore attestation). The previously-recommended `gh release create` is reframed as a last-resort "CI itself is broken" fallback, with a note that locally-uploaded assets cannot be sigstore-attested.

### Internal

- **`pnpm-lock.yaml` is gitignored.** npm's `package-lock.json` remains the source of truth for reproducible installs (it's what Athena's auto-bump and the CI release workflow use); pnpm regenerates its own lockfile from `pnpm-workspace.yaml` on every install. The trade-off — pnpm's transitive resolution isn't pinned — is bounded because npm pins everything anyway, and is documented inline in `.gitignore`.

- **`scripts/release-smoke-test.sh`** header comment updated to reflect the post-`.npmrc` mechanism — `pnpm-workspace.yaml` + per-package `file:` deps as the load-bearing pair.

### Compatibility

- **No behavior change for end users.** Identical bundle, identical features, identical UI.
- **No new code dependencies.** Same SDKs, same versions, same `node_modules` shape.
- **First release built in CI.** v1.5.2 was uploaded manually because its workflow file was introduced in the same commit as the tag — GitHub's first-run timing prevented the tag-push from firing it. v1.6.0's tag-push fires the now-registered workflow end-to-end, producing sigstore build-provenance attestations for `main.js`, `manifest.json`, `styles.css`, and the install zip. The "2 release assets missing GitHub artifact attestation" scorecard warning that lingered on v1.5.2 clears once Obsidian's scanner moves to v1.6.0.
- **Test count**: 1055 (v1.5.2) → 1055 (this release; no test code touched).
- **Workspace dep declarations**: `"@gryphon/<sibling>": "*"` → `"@gryphon/<sibling>": "file:../<sibling>"` in `packages/plugin/package.json` and `packages/provider-runtime/package.json`. Downstream consumers vendoring this repo as a submodule (Athena) install via npm; npm honors `file:` paths the same way it honored the previous `*` matching, so the consumer path is unchanged.

## [1.5.2] — 2026-05-16

### Fixed

- **Plugin can now be built from a clean checkout with `pnpm install`.** Obsidian's Community Plugins scorecard runs build verification in a pnpm-based sandbox; pnpm refuses the `workspaces` field in `package.json` and requires its own `pnpm-workspace.yaml`, so the v1.5.1 build crashed before installing `esbuild`. The pnpm-workspace file is now present and the workspace packages link locally via `.npmrc`. Both `npm install` and `pnpm install` produce identical bundles.
- **Stylesheet rewritten to drop `!important`, `:has()`, and a duplicate selector.** Specificity is now provided via parent-class scoping (`.gryphon-container ...`) and a `[data-type="gryphon-view"]` attribute selector rather than `!important`. No visual regression in the standalone test vault.
- **README placeholder hunt.** Template-flavoured variable syntax (`<drive>`, `{vault}`, `<escaped-cwd>`, `<vault>`) is gone — replaced with concrete examples or natural-language paths. Install instructions, contributing notes, and the privacy table updated to match the post-launch state.

### Added

- **GitHub Actions release workflow.** `.github/workflows/release.yml` builds the plugin in CI on each tag push, attaches sigstore build-provenance attestations to every release asset (`main.js`, `manifest.json`, `styles.css`, install zip), and creates the GitHub Release using the matching CHANGELOG section as the body. Replaces the manual `gh release create` + asset upload step that ran on the maintainer's local machine. The local `cut-public-release.sh` still drives the dev-side commit, tag, and push; everything from there happens in CI.
- **Smoke test exercises the pnpm path.** `scripts/release-smoke-test.sh` now runs `pnpm install + pnpm run build` (if pnpm is installed locally) in addition to the existing npm-path check. The Obsidian-sandbox failure mode is now load-bearing in the release gate.
- **Explicit network endpoint and system-identity disclosures** in `README.md` enumerate the full surface that bundled SDKs (`@anthropic-ai/sdk`, `openai`, `@google/genai`) could contact, called out per provider mode. Identity reads (`os.hostname`, `os.userInfo`, env-var lookups for CLI auto-detection) are documented for transparency. None of this changes runtime behavior.

### Compatibility

- **No behavior change for end users.** Same APIs, same UI, same chat surface, same vault tools.
- **No new code dependencies.** `@gryphon/*` workspace packages still resolve via `"*"` and an `.npmrc` so the npm install path Athena uses is unchanged.
- **Athena auto-bump path verified.** `release-smoke-test.sh` runs the npm-install + require-each-legacy-path sequence Athena depends on; v1.5.2 ships only after that gate passes.
- **Test count**: 1056 → 1056 (the v1.5.1 back-compat-shims regression test continues to pass; no new tests added in this release).

## [1.5.1] — 2026-05-10

### Fixed

- **Restored back-compat import paths for downstream consumers.** v1.5.0 moved every source file into per-axis workspace packages (`packages/{plugin,protect,provider-runtime,provider-config}/src/...`), which broke any project that vendored Gryphon as a git submodule and imported from the legacy `vendor/gryphon/src/...` paths to subclass `GryphonChatView` or wrap pricing tables. v1.5.1 ships a thin re-export layer at the pre-v1.5 paths so submodule consumers can advance their pin without code changes. See `src/README.md` for the contract surface and the drop-the-shims criteria.
- **Regression test pins the contract.** A new `back-compat-shims.test.js` enforces that every legacy path resolves and re-exports the symbols downstream code destructures, so future internal refactors fail in CI before they can ship a broken release.

### Compatibility

- **No behavior change for end users.** All v1.5.0 functionality is preserved unchanged.
- **No new public API.** The shim layer is purely additive — it does not expose anything that wasn't already public via the v1.4.x layout.
- **Test count**: 1053 (v1.5.0) → 1056 (this release; +3 tests in `back-compat-shims.test.js`).

## [1.5.0] — 2026-05-09

### Internal (no user-visible behavior change)

- **Architectural reorganization** into separately-versioned packages: provider configuration, the LLM runtime, the runtime-protection layer, and the Obsidian plugin shell now live in independently-evolvable code units. This is foundation work for upcoming protection-content updates and standalone library distribution. See `docs/adr/0006-three-axis-workspace-split.md` for the full rationale and consequences.
- **`createProtectionContext({ plugin, settings })` factory** added as the unified consumer entry into the protection layer. Wraps spawn-preparation, classify, and availability checks behind a single object. Enables non-Obsidian consumers (CLI hosts, web apps, custom plugins) to inject Gryphon's protection without reaching for individual modules.
- **`require("obsidian")` made lazy** in the permission gate. Modules that transitively reach into the protection layer no longer trigger an Obsidian-runtime resolve at module load — useful for non-UI code paths and Node test runners that haven't registered an `obsidian` stub.
- **Public package surfaces** for each layer: `@gryphon/protect`, `@gryphon/provider-runtime`, `@gryphon/provider-config`. All four packages (including `@gryphon/plugin`) ship together as the single Obsidian plugin distribution; the splits are internal.

### Compatibility

- **No behavior change for end users.** Every v1.4.x feature works identically. Settings persist normally; no migration needed. Hooks fire identically. Permission modes work identically.
- **No change for downstream consumers** that vendor this repo via git submodule. The shipping artifacts (`main.js`, `manifest.json`, `styles.css`, `hooks/`) are at the same paths as before.
- **Test count**: 1052 (v1.4.2) → 1052 (this release; same coverage, redistributed across four workspaces — 156 plugin / 502 protect / 51 provider-config / 343 provider-runtime).
- **Build size**: 1231.0 KB → 1297.6 KB (the small increase reflects the public-API surface added to each package's index.js; future minified-distribution builds will recover most of it).

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

