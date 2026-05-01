# Contributing to Gryphon

Thanks for your interest in Gryphon! This document covers the development workflow and contribution conventions.

## Getting started

```bash
git clone https://github.com/polleoai/gryphon.git
cd gryphon
npm install
npm run build
```

Install the built plugin into a test vault:

```bash
cp main.js manifest.json styles.css /path/to/vault/.obsidian/plugins/gryphon/
```

Reload Obsidian (Cmd+R / Ctrl+R) to pick up changes. For a faster iteration loop, run `npm run dev` — esbuild watches `src/` and rebuilds on every save.

## Project layout

```
src/
├── plugin.js            — Obsidian plugin entry + settings UI
├── chat-view.js         — streaming chat UI
├── constants.js         — slash commands, models, permission modes
├── skills.js            — skill file loader + dynamic slash commands
├── bundled-skills.js    — pre-populated skill content
├── utils.js             — shared helpers
└── providers/
    ├── provider-interface.js  — contract documentation
    ├── factory.js             — selects CLI or SDK per settings
    ├── cli/claude-code-cli.js — local `claude` CLI subprocess provider
    └── sdk/
        ├── anthropic-sdk.js   — direct API client
        ├── tool-loop.js       — multi-turn tool-use driver
        └── tools/             — tool implementations + registry
```

Build output goes to `main.js` at the repo root (Obsidian's convention).

## Code conventions

- **CommonJS modules.** Not ESM — Obsidian's bundle expects CJS.
- **No TypeScript.** JavaScript + JSDoc type hints. Keeps the build simple.
- **Minimal runtime dependencies.** Currently `@anthropic-ai/sdk` and `undici`. Anything extra bloats the bundle significantly; discuss in an issue first.
- **Comments should explain *why*, not *what*.** The code should be self-explanatory; comments capture non-obvious decisions, constraints, or tradeoffs — past incidents that motivated current code, invariants that a future reader could break.
- **Vault-scoped filesystem access.** Every tool that reads/writes files MUST route paths through `providers/sdk/tools/path-utils.js`. Vault root = cwd passed to the provider.
- **Never bypass permission gates.** Write, Edit, Bash, and PowerShell must always call `checkPermission()`. Direct filesystem ops outside this contract are security regressions.
- **No mechanism leakage in user-visible strings.** Settings labels, modal text, deny reasons, and the system prompt sent to Claude must not name "hook", "PreToolUse", "PostToolUse", "IPC", or describe how Gryphon's check works internally. Code comments and JSDoc are exempt — only user-visible surfaces. This is a positioning + UX concern, not a security one.
- **Gryphon ships standalone.** No file committed to this repository — source, docs, tests, examples, comments, or commit messages — may reference internal consumer project names. Enforced by `tests/no-internal-refs.test.js` — add any new forbidden token there if a consumer project name arises.

## Architecture invariants (do not regress)

These are documented inline at each enforcement point; restated here for visibility:

1. **Two-axis security model.** Permission modes (Prompt / Safe / YOLO / Plan) are a convenience layer for routine operations. The protected-pattern rule set is the guardrail layer for dangerous ones — patterns matching `DEFAULT_PROTECTED_*` always show an approval modal regardless of mode. Don't add YOLO-aware exceptions inside `attack-detector.gate` or `permission-gate.checkPermission` — the fix for "YOLO didn't block X" is always (a) update docs to set expectations, or (b) extend the pattern list if a real new danger was missed.
2. **Vault-scope check is fail-closed.** `resolveVaultPath` rejects out-of-vault paths before any file I/O. Every Read / Write / Edit goes through it.
3. **PreToolUse + SessionStart hooks fail-closed.** Any IPC error, crash, or wall-clock timeout produces a `deny`. Other hooks fail-open — losing them degrades framing but doesn't unprotect the session.
4. **Single-quote PowerShell paths on Windows.** Hook command strings emit `& 'C:\path\node.exe' 'C:\path\hook.js'` — never double-quoted. CC wraps the command in its own `-Command "..."` outer quotes; inner `"` gets consumed and the hook silently doesn't fire. See `src/providers/cli/hook-settings-builder.js` for the full rationale.
5. **No telemetry, ever.** Diagnostics that produce console output are fine; anything that writes to a file beyond `{tmp}/gryphon-hook-trace.log` (already opt-in via Settings → Diagnostics) needs a strong justification and explicit user consent.

## Adding a new provider

1. Read `src/providers/provider-interface.js` for the contract.
2. Create `src/providers/<name>/<name>.js`. Implement `send(prompt)`, `abort()`, `isAlive()`, `resolvedModel`, `contextTokens`.
3. Add a branch in `src/providers/factory.js` for the new provider.
4. Settings UI: add a provider-preference entry in `constants.js` PROVIDER_PREFS.
5. Tests for the new provider go under `tests/providers/<name>.test.js` (test harness forthcoming).

## Adding a new SDK tool

1. Create `src/providers/sdk/tools/<name>.js` exporting `{ SCHEMA, execute }`.
2. `SCHEMA.name` must match the tool name the model uses.
3. `execute(input, ctx)` must always return `{ content: [...], isError: boolean }` — never throw; errors return as `isError: true`.
4. Register in `src/providers/sdk/tools/tool-registry.js` under the appropriate phase bucket (read-only / write / web-bash).
5. If the tool mutates state or runs code, call `checkPermission()` with a clear `action` and `target` for the modal.

## Cross-platform testing on a VM

Most contributors will iterate on macOS, but the v0.8 fixes for Windows CLI hooks needed a real Windows VM to land. `scripts/deploy-to-vm.sh` automates the rebuild → repackage → serve cycle so you can pull a fresh build into a VM with one paste.

```bash
./scripts/deploy-to-vm.sh                # rebuilds, packages, serves on :8000
./scripts/deploy-to-vm.sh --no-build     # reuse existing main.js
./scripts/deploy-to-vm.sh --port 9000    # different port
```

The script prints two paste-safe one-liners — one for Linux, one for Windows PowerShell — that download and install the build into the VM's plugin directory. Both are semicolon-chained to survive terminal paste newline-collapse, which is a common foot-gun in both bash and PowerShell.

VM setup gotchas (covered in detail in the bundled `MANUAL.md → Platform-specific troubleshooting`):

- **Windows:** Git for Windows must be installed (Gryphon uses Git Bash for some internal paths). Set `CLAUDE_CODE_GIT_BASH_PATH` env var if `claude` errors with "requires git-bash". Run `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned` if `npm.ps1` is blocked.
- **Linux Flatpak:** Obsidian's Flatpak sandbox can't see `/usr/bin/claude`. Either install claude under `~/.npm-global/` or grant Flatpak `--filesystem=/usr:ro` access.

## Repository structure

This repo (`polleoai/gryphon`) is the canonical home for external contributors and the source the Obsidian community plugin listing resolves against. External contributions (issues, pull requests, forks) all target this repo.

Each tagged release is published here as a GitHub Release with `main.js`, `manifest.json`, and `styles.css` attached as assets for [BRAT](https://github.com/TfTHacker/obsidian42-brat)-based install.

## Submitting changes

1. Fork the repository.
2. Create a feature branch: `git checkout -b feat/my-change`.
3. Make your change. Commit with a clear message (`type(scope): summary` — see existing CHANGELOG for examples).
4. `npm test` passes (full suite, ~350 tests).
5. `npm run build` produces a clean bundle.
6. If the change touches Windows CLI: tested on a real or VM Windows install (see above).
7. **If the change touches regex in `DEFAULT_PROTECTED_*` or any security-adjacent code**, run `semgrep scan --config p/security-audit` on the diff. ReDoS and injection patterns that slip through manual review get caught here cheaply.
8. Open a PR describing what changed and why. CHANGELOG entry under the next-version heading if user-visible.

## Reporting issues

- **Bugs:** [github.com/polleoai/gryphon/issues](https://github.com/polleoai/gryphon/issues). Include:
  - OS (macOS / Linux / Windows + version) and Obsidian version
  - Gryphon version (Settings → Gryphon → bottom of the page)
  - Provider (CLI / SDK), model, permission mode
  - Reproduction steps
  - Expected vs. actual behavior
  - Console output from Obsidian Dev Tools (Cmd+Opt+I on macOS, Ctrl+Shift+I elsewhere). Turn on **Settings → Gryphon → Diagnostics → CLI debug logging** before reproducing if the bug is in Claude Code mode — the logs will be much more useful.
  - Do NOT include your API key or any vault content you'd prefer to keep private.
- **Vulnerabilities:** see [SECURITY.md](./SECURITY.md) — please report privately, not via public issues.
- **Discussions / questions:** [github.com/polleoai/gryphon/discussions](https://github.com/polleoai/gryphon/discussions).

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
