# Security policy

Gryphon runs in Obsidian's renderer process with access to your vault files and, depending on configuration, to the Anthropic API and a locally-installed `claude` CLI subprocess. We take security reports seriously and treat them with priority over feature work.

## Reporting a vulnerability

**Please report security issues privately, not via public GitHub issues.**

Email: **gryphon@polleo.ai** (monitored by the maintainers).

If email isn't an option, open a GitHub **private security advisory** via the repository's Security tab (`https://github.com/polleoai/gryphon/security/advisories/new`). We'll respond from there.

In your report, please include:

- A description of the issue and its impact (what can an attacker achieve?)
- The affected Gryphon version (see `manifest.json` `version` field, or Settings → Gryphon → version footer)
- Your operating system and Obsidian version
- Steps to reproduce — a minimal reproducible example is most valuable
- Any relevant logs (strip API keys and private vault content before pasting)

## Response timeline

- **Acknowledgement:** within 3 business days of receipt
- **Initial assessment:** within 7 business days — we'll tell you whether we've confirmed the issue and what our intended fix window is
- **Fix + disclosure:** depending on severity, typically within 30 days for high-severity issues. Low-severity issues may ride a regular release cycle.

We'll keep you updated at each step. Credit (with your consent) is given in the CHANGELOG entry and GitHub advisory.

## Scope

**In scope:**

- Prompt injection that causes Gryphon to perform actions outside the vault boundary
- Bypasses of the protected-pattern modal (file paths, commands) in any permission mode
- Path-traversal vulnerabilities in the vault-scope check
- IPC socket / named pipe authentication issues
- Arbitrary code execution through Gryphon's tool-use pipeline
- Credential or vault-content leakage to unintended destinations
- Hook-command injection via the Claude Code settings file

**Out of scope** (but still welcomed as issues, just not confidential):

- Bugs in the Anthropic API or Claude models themselves — report to Anthropic directly
- Bugs in the upstream `claude` CLI — report to that project
- Obsidian core vulnerabilities — report to Obsidian
- Third-party npm dependencies — report to the respective maintainers; we'll update our pin after they patch
- DoS through pathological input (open an issue; these are bugs but not confidential)

## What Gryphon does with your data

- **Anthropic API key**: stored in Obsidian's plugin-data (`{vault}/.obsidian/plugins/gryphon/data.json`), never transmitted except as the `x-api-key` header to `api.anthropic.com`
- **Vault files**: read/written locally by your instruction. Content is sent to the Anthropic API (Anthropic API mode) or the local `claude` subprocess (Claude Code mode) only as part of tool-use turns in an active conversation
- **Chat history**: persisted to `{vault}/.obsidian/plugins/gryphon/chat-history.json`; LLM turns in Claude Code mode additionally persist under `~/.claude/projects/` (owned by Claude Code, not by Gryphon)
- **Diagnostics**: when **Settings → Gryphon → Diagnostics → CLI debug logging** is on (default off), the plugin writes console-side debug lines and appends hook-invocation traces to `{tmp}/gryphon-hook-trace.log`. All of this is console/local only — nothing is sent off-device by Gryphon itself
- **No telemetry**: Gryphon does not include analytics, crash reporting, or any opt-out-required telemetry

## Known safety boundaries

- **Vault scope**: the `resolveVaultPath` check (`src/providers/sdk/tools/path-utils.js`) rejects any path that resolves outside the vault root, including via `..` traversal, symlink escape, and URL-encoded variants. Enforced before any file I/O and independent of the active permission mode.
- **Network restrictions**: WebFetch rejects URLs that resolve to private / loopback / cloud-metadata IP ranges before sending the request. Enforced as a fail-closed DNS-resolution check.
- **Protected-pattern modal**: matches against `DEFAULT_PROTECTED_PATHS` and `DEFAULT_PROTECTED_COMMANDS` always show an approval modal regardless of permission mode (see README "Built-in security" section for the two-axis design).
- **IPC socket** (Unix): created with `0600` permissions in `$TMPDIR`, accessible only to the process owner. Named pipe (Windows): identifier is randomized per session.
- **Fail-closed hooks**: PreToolUse and SessionStart hooks deny on any IPC error, crash, or wall-clock timeout rather than silently allowing. Defense in depth against a crashed plugin leaving the CLI unprotected.

## Dependencies

Security-relevant runtime dependencies (see `package.json` for exact versions):

- `@anthropic-ai/sdk` — HTTP client for the Anthropic API
- `undici` — underlying HTTP stack used by WebFetch / WebSearch

Build-time:

- `esbuild` — bundler

We do not ship any dependency with known unpatched CVEs. When a CVE is published against one of our dependencies, we'll issue a patch release. Report upstream issues to the respective maintainers.

---

Thank you for helping make Gryphon safer.
