/**
 * Bundled vault docs shipped with Gryphon. Seeded into the vault's
 * `Gryphon/` folder (parent of `Gryphon/Skills/`) on first plugin load.
 *
 * Same write-once contract as bundled-skills.js: existing files are
 * never overwritten, so user customizations survive plugin upgrades.
 * To force a refresh of the manual, the user deletes the file and
 * reloads Gryphon — the bundled copy reappears.
 *
 * The manual lives in the vault (not the plugin code directory) so it
 * shows up in Obsidian's file tree where users actually look for help.
 */

const MANUAL = `# Gryphon — User Manual

Gryphon is a chat plugin that connects Obsidian to Claude. You can read
and edit your vault files, run shell commands, and search the web — all
inside Obsidian.

This manual lives in your vault at \`Gryphon/MANUAL.md\`. Edit or delete
freely; it's seeded on first install but never overwritten.

---

## Getting started

Gryphon connects to Claude via the **Anthropic API** (pay-per-token).
Paste a key from [console.anthropic.com](https://console.anthropic.com)
into **Settings → Gryphon → Anthropic API key**.

Advanced users with a locally-installed \`claude\` CLI can optionally
switch **Settings → Gryphon → Provider** to "Claude Code (advanced)"
to spawn it as a subprocess. Before enabling, confirm your intended
usage complies with that product's terms — Gryphon is not affiliated
with Anthropic.

If neither is set up when you open Gryphon for the first time, you'll
see a welcome panel with two cards — one for each path. Click the
appropriate "Use this" button (or follow the install link) to
configure.

---

## Vault location and cloud sync

**Where your vault lives matters.** Obsidian installs plugins at
\`<vault>/.obsidian/plugins/<plugin-id>/\` — the path is fixed by
Obsidian, so Gryphon always sits inside your vault. If your vault
directory is synced by iCloud, OneDrive, Dropbox, Syncthing, or
similar, those services can rename plugin files during sync conflicts
(iCloud appends \`" 2"\`, Dropbox adds \`"(conflicted copy ...)"\`,
OneDrive uses \`"-Conflict"\`, Syncthing uses
\`".sync-conflict-<timestamp>"\`). A renamed hook script causes
Gryphon's CLI-mode protection to fall back to deny-only with a
visible warning, but the safer choice is to keep the vault outside
synced paths.

### Recommended vault locations

| OS | Safe by default | Avoid |
|---|---|---|
| macOS | \`~/Obsidian/\`, \`~/Vaults/\`, \`~/Notes/\` — any path you choose that's not iCloud-synced | \`~/Documents/\`, \`~/Desktop/\`, \`~/iCloud Drive/\`, \`~/Library/Mobile Documents/\` |
| Windows | \`C:\\Users\\<you>\\Obsidian\\\`, \`D:\\Vault\\\`, any path outside OneDrive's scope | \`C:\\Users\\<you>\\Documents\\\`, \`C:\\Users\\<you>\\Desktop\\\` (default OneDrive roots when OneDrive is on) |
| Linux | Most paths are fine by default — Linux rarely auto-syncs | Any path you've explicitly added to Dropbox, Nextcloud, Insync, Syncthing, or similar |

### How to check if your current vault is cloud-synced

- **macOS:** right-click the vault folder in Finder → "Get Info" → look for "iCloud" in the path. Or check whether the folder icon has a cloud/sync badge.
- **Windows:** right-click the vault folder → Properties → General tab. OneDrive-synced folders show a "OneDrive" attribute. Or check the folder's icon overlay (cloud glyph).
- **Linux:** check whether the path is inside a sync service's configured directory (\`~/.config/syncthing\`, \`~/.dropbox\`, etc.) and review that service's share list.

### If your vault is already cloud-synced

Two options:

1. **Move the vault** to a non-synced location. In Obsidian: close the vault, move the folder in your file manager, reopen Obsidian and "Open folder as vault" pointing at the new location. All your notes, plugin configs, and history move with it.
2. **Accept the risk and rely on Gryphon's defensive check.** If a sync conflict renames a hook script (e.g. \`hooks\` → \`hooks 2\`), Gryphon detects the missing script on next launch and shows a toast: "Gryphon: CLI hook protection disabled — falling back to deny-list." You'd then rename the folder back manually (or reinstall). You stay protected by the \`--disallowedTools\` fallback in the meantime, but you lose the approve-per-call modal UX until the rename is fixed.

Sync services are also a concern for \`chat-history.json\`, \`data.json\`, and \`provenance.json\` — Gryphon writes these at runtime, and if two devices edit the vault simultaneously you may get conflict copies. Single-device use is the simple answer; multi-device users should either not use a single shared vault across live Obsidian sessions or accept occasional conflict files to clean up.

---

## The chat panel

Open Gryphon via:

- The "send" icon in the left ribbon, OR
- Command palette → **"Gryphon: Open chat"**, OR
- Hotkey (Settings → Hotkeys → search "Gryphon")

The chat panel docks to the right sidebar by default. To open in the
main editor area instead, toggle **Settings → Gryphon → Open in main
tab**.

### Sending messages

- **Enter** sends the message
- **Shift+Enter** inserts a newline (multi-line input)
- The send button (paper-plane icon) also sends

While Claude is responding, the input is disabled and a "Stop" button
appears in the toolbar. Click it (or use \`/stop\`) to abort the turn.

### Auto-context

Every message you send is silently prefixed with a small
\`[gryphon-context]\` block telling Claude what file you currently have
open and which folder it's in. References like *"this note"* or *"this
folder"* in your prompt resolve correctly without you having to spell
them out.

This adds ~50 tokens per message; cost is negligible.

---

## Slash commands

Type \`/\` in the input to see all available commands in the
autocomplete dropdown. Press **Tab** to complete the highlighted entry,
**Enter** to send.

| Command | What it does |
|---|---|
| \`/clear\` | Start a new session (with confirmation if non-empty) |
| \`/compact\` | Summarize the conversation and continue with the summary as context |
| \`/context\` | Show context-window usage (% of model's max) |
| \`/cost\` | Show session cost (suffixed \`(est.)\` in Anthropic API mode) |
| \`/effort\` | Switch effort level (low / medium / high) |
| \`/export\` | Save the conversation as a note in \`Gryphon/Exports/\` |
| \`/help\` | Open this help reference as a modal |
| \`/model\` | Switch model (haiku / sonnet / opus) |
| \`/perm\` | Switch permission mode (Prompt / Safe / YOLO / Plan) |
| \`/quote\` | Insert highlighted editor text as a quoted reference |
| \`/settings\` | Open Gryphon settings |
| \`/stop\` | Stop the current turn |
| \`/usage\` | Show messages, cost, tokens, duration |

Plus any custom skills you've created — see **Skills** below.

---

## Keyboard shortcuts

| Key | Action |
|---|---|
| **Enter** | Send message |
| **Shift+Enter** | Newline |
| **↑** (cursor not at start) | Jump cursor to start of prompt |
| **↑** (cursor at start, or empty) | Walk back through prompt history |
| **↓** (cursor not at end) | Jump cursor to end of prompt |
| **↓** (cursor at end, in history) | Walk forward through history |
| **Tab / Enter** (autocomplete open) | Complete selected command |
| **Esc** (autocomplete open) | Close dropdown |

Prompt history persists across plugin reloads. Up to 100 most recent
prompts are recallable.

---

## Permission modes

When Claude wants to write a file, edit a file, or run a shell command,
the permission mode decides what happens:

| Mode | File reads | Normal file writes | Normal shell commands | Protected file / command |
|---|---|---|---|---|
| **Prompt** (default) | Always allowed | Modal per file | Modal per command | Modal (always) |
| **Safe** | Always allowed | Auto-accept | Modal per command | Modal (always) |
| **YOLO** | Always allowed | Auto-accept | Auto-accept | Modal (always) |
| **Plan** | Always allowed | Refused | Refused | Refused |

In **Prompt** mode, a confirmation modal appears for each file edit and
each shell command. The modal shows:

- The file path or full command
- A diff preview (Edit) or content preview (Write)
- "Remember for this session" checkbox (file edits only — shell
  commands always re-prompt for safety)

In **Plan** mode, Claude can read your vault but won't write or run
anything. Use this when you want to discuss approaches before doing.

### Protected Mode — the master for protected patterns

The rightmost column in the table above reflects the default state:
**Protected Mode is ON** and operations matching your protected lists
go to a modal regardless of permission mode. Two Settings toggles
shape that response:

| Protected Mode | Auto-deny | Behavior when a protected pattern matches |
|---|---|---|
| **ON** (default) | OFF (default) | Approve/deny modal. You decide per-operation. |
| **ON** | ON | Refused outright with a prescriptive reason. No modal. |
| **OFF** | — | Not enforced. Protected patterns are treated like any other op; your permission mode (Prompt / Safe / YOLO) governs them entirely. |

**Auto-deny** is useful for batch work where you'd rather edit Settings
once than dismiss repeated modals. Protected Mode ON + Auto-deny ON
gives you predictable automation without silent approvals of dangerous
ops.

**Turning Protected Mode OFF** disables the pattern-based override
entirely. In YOLO mode with Protected Mode OFF, protected patterns
are auto-approved silently — this is "real YOLO" with no exceptions.
Use with eyes open. The pattern list still exists (you can switch
Protected Mode back on at any time), it just isn't enforcing anything
while OFF.

Examples of what the default setup (Protected Mode ON, Auto-deny OFF)
gates with a modal:

- Writes into \`.obsidian/\`, \`.git/\`, \`.claude/\`, \`.env\`
- Commands matching \`rm -rf\`, \`Remove-Item -Recurse\`, \`sudo\`,
  \`curl | bash\`, \`iwr | iex\`, \`format <drive>:\`, etc.
- Any custom pattern you've added under
  **Settings → Gryphon → Protect file paths / Protect commands**

To allow a specific protected operation once, approve it from the
modal. To allow a category consistently, uncheck the pattern in Gryphon
Settings — switching permission mode to YOLO won't bypass a match
while Protected Mode is ON.

### SDK and CLI behave identically

Protected Mode and Auto-deny work the same way regardless of which
provider Gryphon is using (SDK or local CLI). Both read the same
settings and produce the same user-visible outcome. The enforcement
mechanism differs internally (SDK uses in-process checks; CLI uses
hooks or a deny-list settings file passed to Claude Code), but you
don't need to think about that.

### Vault-only access

Even in YOLO mode, file paths are validated against your vault root.
Claude can never read or write outside the vault, regardless of any
prompt-injection attempt.

### Protecting your own content folders

The built-in protected-paths list covers **Gryphon's and Obsidian's own
settings** (\`.obsidian/\`, \`.git/\`, \`.claude/\`, etc.) — not your
notes. In Safe or YOLO mode, Claude can freely overwrite any note
inside your vault. For a notes-only vault that's usually fine; for a
vault containing irreplaceable content, it may not be.

If you want Claude to always ask before touching specific folders or
files inside your vault, add them under **Settings → Gryphon →
Protect file paths → Your rules**. Writes to matching paths always
prompt — even in Safe or YOLO mode.

Examples:

| Entry | Meaning |
|---|---|
| \`Journal/\` | Any write inside the Journal folder (trailing slash = folder prefix) |
| \`Archive/2023/\` | Writes inside a specific subfolder |
| \`thesis.md\` | A specific file (no trailing slash = exact match) |
| \`.env\` | A dotfile in your vault root |

Good candidates: journal / daily-notes folders, archives, thesis or
manuscript drafts, year-end snapshots, or anything you can't easily
reconstruct from version control. Entries are matched as vault-relative
paths with forward slashes — directory entries (trailing \`/\`) match
the folder and everything under it.

---

## Skills (custom slash commands)

A **skill** is a markdown file in \`Gryphon/Skills/\` that becomes a
slash command. Type \`/<skill-name>\` to invoke it; the file's body is
expanded and sent as a chat message.

### Format

\`\`\`markdown
---
name: weekly-review
description: Summarize what I worked on this week
argument-hint: "[optional: extra focus]"
---
Read the last 7 days of journal entries in journal/ and produce a
summary covering: key decisions, files created or substantially edited,
open questions, and what I should focus on next week.

{{args}}
\`\`\`

\`{{args}}\` is replaced with whatever you typed after the command name
when invoking the skill. Empty if you didn't pass anything.

### Required fields

- \`name\` — slash command (lowercase letters/digits/hyphens, must
  start with a letter)
- \`description\` — one-line summary shown in the autocomplete dropdown

### Reserved names

These names collide with built-in Gryphon commands and will be rejected:
\`clear\`, \`compact\`, \`context\`, \`cost\`, \`effort\`, \`export\`,
\`help\`, \`model\`, \`perm\`, \`quote\`, \`settings\`, \`stop\`, \`usage\`.

### Three ways to create a skill

1. **Ask Claude in chat** (easiest):
   *"Create a Gryphon skill called weekly-review that summarizes my
   journal entries from the last 7 days."*
   Claude writes the file (Write permission required); the skill
   loader picks it up immediately.

2. **Copy a bundled example**: duplicate any file in \`Gryphon/Skills/\`,
   rename, edit the frontmatter, save.

3. **Write from scratch**: create an \`.md\` file in
   \`Gryphon/Skills/\` with the format above.

The folder is live — Gryphon watches for changes, no plugin reload
required.

### Bundled examples

Five skills ship pre-populated:

- \`/tag-suggest\` — propose tags for the active note
- \`/backlinks\` — list backlinks with context snippets
- \`/forward-links\` — list outgoing wikilinks, flag broken ones
- \`/summarize\` — summarize the active note
- \`/lint-note\` — check for common issues (broken links, missing
  frontmatter, inconsistent headings)

Delete them if you don't want them; they won't be re-created. See
\`Gryphon/Skills/README.md\` for the full skill format reference.

---

## Settings

**Settings → Gryphon** has these sections:

### Provider

- **Provider** — Auto / Claude Code / Anthropic API
- **Claude Code path** — leave blank for auto-detect
- **Anthropic API key** — for Anthropic API mode (paste here; env var also works
  if Obsidian was launched from a shell that has the variable set)
- **Brave Search API key** — for SDK-mode WebSearch (free tier at
  [brave.com/search/api](https://brave.com/search/api/))

### Defaults

- **Default model** — Haiku / Sonnet / Opus / Opus 1M
- **Default effort** — Low / Medium / High
- **Default permissions** — Prompt / Safe / YOLO / Plan
- **Open in main tab** — chat opens in the main area instead of sidebar

---

## Privacy and data flow

Gryphon is local-first. Nothing leaves your machine unless you send a
chat message or Claude invokes a network-using tool in response.

**Your API key** lives in
\`{vault}/.obsidian/plugins/gryphon/data.json\` and is sent only as an
\`x-api-key\` header to \`api.anthropic.com\` in Anthropic API mode. Never logged,
never exported to another file.

**Vault content** is sent to the Anthropic API (Anthropic API mode) or to your
locally-installed \`claude\` CLI (Claude Code mode) only when Claude invokes a
file or shell tool during an active conversation. Outside an active
turn, the plugin is inert.

**Chat history** persists locally:
- \`{vault}/.obsidian/plugins/gryphon/chat-history.json\` — Gryphon-owned
  (system messages, slash-command output, SDK LLM turns)
- \`~/.claude/projects/<escaped-cwd>/<session-id>.jsonl\` — CLI-owned
  (LLM turns in Claude Code mode). Delete this file to force a fresh CLI
  session.

**No telemetry.** Gryphon does not include analytics, crash reporting,
or any opt-out data collection. There is no "phone home" path.

**Diagnostics are opt-in.** Turning on **Settings → Gryphon →
Diagnostics → CLI debug logging** produces console output and a trace
log at \`{tmp}/gryphon-hook-trace.log\`. Both are local only; nothing
is sent off-device. Default off.

What leaves your machine per tool invocation:

| Tool | Destination |
|---|---|
| Chat message | \`api.anthropic.com\` (SDK) / local CLI subprocess |
| Vault file (read / write / edit) | Same as above, embedded in the turn |
| WebFetch | The URL's origin |
| WebSearch | \`api.search.brave.com\` (SDK with key) / Anthropic search (CLI) |
| Read / Glob / Grep on vault files | Local only — tool *result* is then sent back to the model |
| Bash / PowerShell | Local only — command output is then sent back to the model |

For vulnerability reporting, see the SECURITY.md file at the repo root.

---

## Troubleshooting

### Gryphon doesn't open

Check **Settings → Community plugins** that Gryphon is enabled. If
another plugin embeds Gryphon as a submodule, it may disable this
standalone copy on its own load — that's by design (mutual exclusivity
prevents two Gryphon instances fighting over the same command registry).

### "No provider available" message

No API key is set AND no local \`claude\` binary is detected, OR you've
selected a provider preference that doesn't have a backing
configuration. The welcome panel inside the chat will guide you through
setup.

### "Credit balance too low" when using SDK

You need to add credits at
[console.anthropic.com → Plans & Billing](https://console.anthropic.com/settings/billing).
Note: the Anthropic API has its own credit pool; subscription plans
for other Anthropic products are billed separately.

### Welcome panel keeps appearing after I configured a key

Click the "Use Anthropic API" button in the panel (or change Provider
to Auto/SDK in settings). The panel only auto-hides when a provider
can resolve based on your current preference + configuration.

### Cost in /cost doesn't match my Anthropic invoice

Two possibilities:
1. Claude Code mode: cost is server-attested by whichever backend the local
   CLI is configured against. Depending on the CLI's billing model,
   the figure may not match per-request Anthropic API invoices.
2. Anthropic API mode: cost is computed locally from a price table that may
   drift from current Anthropic pricing — that's why \`/cost\` shows
   \`(est.)\` in Anthropic API mode. For authoritative billing, see your
   Anthropic dashboard.

### A skill file isn't appearing in autocomplete

Gryphon shows skill load errors in chat as a system message. If you
don't see one, the file's probably outside \`Gryphon/Skills/\` or
doesn't have the \`.md\` extension. Open the dev console (Cmd+Opt+I)
and look for \`[gryphon] Skill\` log lines for details.

### Nothing happens when I type a /command and press Enter

Likely the autocomplete dropdown is open. Press **Esc** to close it,
then **Enter** to send. Or press **Tab** to complete the highlighted
entry first, then **Enter**.

### A WebFetch always fails on certain sites

Sites with strict anti-bot WAFs (Cloudflare managed challenge, X /
Twitter, LinkedIn, Reddit) block automated requests by design. Use
\`WebSearch\` instead — it surfaces the content via indexed third-party
sources. Claude often suggests this fallback on its own.

---

## Platform-specific troubleshooting

### Claude Code mode: "claude not found"

Gryphon auto-detects the \`claude\` binary in common install locations
on macOS, Linux, and Windows. If none match your setup:

1. Find the binary yourself. On POSIX: \`which claude\`. On Windows
   PowerShell: \`Get-Command claude | Select-Object Source\`.
2. Paste the full path into **Settings → Gryphon → Claude Code path**.
3. The status line below the field should turn green and show the
   path in use.

### Claude Code mode (Linux): Flatpak Obsidian can't see \`/usr/bin/claude\`

Flatpak-installed Obsidian runs in a sandbox that only has access to
your home directory by default. System-wide binaries under
\`/usr/bin/\` or \`/opt/\` are invisible. Two workarounds:

1. **Install claude under your home directory:**
   \`\`\`
   npm config set prefix ~/.npm-global
   npm install -g @anthropic-ai/claude-code
   \`\`\`
   Then restart Obsidian. Gryphon will detect
   \`~/.npm-global/bin/claude\` automatically.

2. **Grant Flatpak read access to /usr:**
   \`\`\`
   flatpak override --user --filesystem=/usr:ro md.obsidian.Obsidian
   \`\`\`
   Then restart Obsidian and set **Settings → Gryphon → Claude CLI
   path** to \`/usr/bin/claude\` (or wherever your install landed).

If neither works, switch to Anthropic API mode and supply an Anthropic API key.

### Claude Code mode (Windows): tool-use modals don't appear

Windows Claude Code mode requires:

1. **Git for Windows** installed (Gryphon uses Git Bash for some
   internal paths). Download from [git-scm.com](https://git-scm.com).
   If the \`claude\` CLI errors with "Claude Code on Windows requires
   git-bash", set the \`CLAUDE_CODE_GIT_BASH_PATH\` environment
   variable to your bash.exe path
   (typically \`C:\\Program Files\\Git\\bin\\bash.exe\`).

2. **Node.js >= 18** installed to a location Gryphon can find. The
   default \`C:\\Program Files\\nodejs\\node.exe\` is auto-detected.

3. **Interactive CLI protection** turned ON in Gryphon settings (this
   is the default). Off means deny-only protection with no modal.

4. If hooks still don't fire after a send, open Obsidian's dev tools
   console (Ctrl+Shift+I) and look for lines starting with
   \`[gryphon/cli]\`. The settings JSON that Gryphon handed to the CLI
   is printed verbatim; you can compare it against the expected
   PowerShell-shell / single-quoted format.

### Claude Code mode (Windows): \`Error: spawn EINVAL\`

Usually a transient from a stale session ID after you switched
platforms or reinstalled. Send the same message again — the error
clears the stored session and the next attempt starts fresh. If it
persists across multiple sends, open the dev tools console and look
for \`[gryphon/cli] process error:\` — that log line includes the
full spawn context (claudePath, arg count, resume session, etc.).
Paste it on a GitHub issue.

### Chat history not restoring after plugin reload

History has two sources:

- \`<vault>/.obsidian/plugins/gryphon/chat-history.json\` —
  plugin-authored messages (system notices, slash-command output).
- \`~/.claude/projects/<escaped-cwd>/<session-id>.jsonl\` — LLM turns
  in Claude Code mode. The \`<escaped-cwd>\` has path separators replaced by
  \`-\` (on Windows, \`C:\\Users\\User\\vault\` becomes
  \`C--Users-User-vault\`).

If LLM turns don't come back in Claude Code mode, check that your last
session ID is stored in Gryphon plugin data
(\`.obsidian/plugins/gryphon/data.json\` — look for \`lastSessionId\`)
AND that the corresponding \`.jsonl\` exists under
\`~/.claude/projects/\`. One of those missing means either Gryphon or
the CLI rotated the session.

### PowerShell execution policy blocks the install script

On first-time setup of the \`claude\` CLI via npm, Windows may refuse
to run \`npm.ps1\` under the default \`Restricted\` execution policy.
Run once in PowerShell as a regular user:

\`\`\`
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
\`\`\`

This affects only your user account and doesn't weaken machine-wide
policy. It's also required by many other npm-installed tools.

### \`ANTHROPIC_API_KEY\` set via \`setx\` isn't visible in current session

\`setx\` writes to the User registry scope but doesn't update the
current process env. Either close and reopen PowerShell, or set it
ephemerally for the session:

\`\`\`
\$env:ANTHROPIC_API_KEY = "sk-ant-..."
\`\`\`

Gryphon (running inside Obsidian) picks up env vars from Obsidian's
launch environment, so restart Obsidian from a shell where the var
is set if you want it visible.

---

## Where to ask for help

- **This manual** — you're reading it
- **/help in chat** — opens a quick-reference modal of commands and shortcuts
- **GitHub issues** — bugs and feature requests at
  [github.com/polleoai/gryphon/issues](https://github.com/polleoai/gryphon/issues)
- **GitHub discussions** — open-ended questions at
  [github.com/polleoai/gryphon/discussions](https://github.com/polleoai/gryphon/discussions)

Privacy reminder: when filing bugs, never paste your API key or vault
content you'd prefer to keep private. A short reproducible example is
more useful than full logs anyway.
`;

module.exports = {
  "MANUAL.md": MANUAL,
};
