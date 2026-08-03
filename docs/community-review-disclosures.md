# Gryphon — Community Review Disclosures

This document explains the elevated capabilities an automated plugin review flags
in Gryphon, why each is present, and how each is bounded. Gryphon is an AI
assistant for Obsidian with a **runtime guardrail**: when a model wants to run a
command or touch a file, Gryphon gates it behind your approval. Several of the
flagged capabilities are precisely the mechanism that makes that protection work
— removing them would remove the guardrail, not make it safer.

All behaviour is local. Gryphon makes network requests only to the model
provider you choose (with your own API key) or via the CLI you select; it has no
telemetry and sends no usage, identity, or vault data anywhere.

## Shell execution (`child_process`)

**Why:** Gryphon runs the coding CLI you select — Claude, Codex, Gemini, or
Antigravity (`agy`) — as a subprocess, and probes each with a `--version` check
for the settings "detected/not detected" status.

**Bounds:** It spawns only (a) the CLI binary you explicitly select in Settings →
Models (auto-detected on `PATH`, or a path you enter), and (b) version probes of
those same binaries. It never fetches or executes remote/arbitrary code. Every
command the model then asks that CLI to run is subject to the approval layer
below.

## Electron IPC (`ipcRenderer` / `ipcMain`)

**Why — this IS the protection.** CLI providers (Antigravity in particular) have
no per-request approval prompt that works outside an interactive terminal, so
Gryphon auto-approves the CLI's tools and takes that decision itself. IPC is how
the guardrail in the main process communicates approval decisions to the plugin
and intercepts tool calls that touch protected files or run protected commands.

**Bounds:** IPC carries only Gryphon's own approval traffic between its plugin
and guardrail components. It is the enforcement channel for Protected mode; it
does not expose any other privileged surface. Turning off Protected mode is a
supported user choice and disables this path.

## Direct filesystem access (`fs`)

**Why:** Gryphon reads/writes its own settings and hook files, and manages the
single shared automation-settings file Antigravity reads from your home
directory — adding Gryphon's guardrail entry when a request starts and removing
it when the request ends (and clearing a leftover entry on next load if Obsidian
was force-quit mid-request), leaving any entries of your own untouched.

**Bounds:** Confined to Gryphon's own configuration, the OS temp dir, and the
specific Antigravity settings file it must manage to protect you. It does not
read unrelated user files.

## System information (`os.platform()` / `os.release()` / `os.homedir()`)

**Why:** Platform detection selects correct behaviour per OS (e.g. the
Windows-specific spawn path and the Windows Antigravity guardrail), and
`os.homedir()` locates the CLI/config paths that live under your home directory.

**Bounds:** Gryphon does **not** read `os.hostname()`, `os.userInfo()`, or
`os.networkInterfaces()` — none of the machine-fingerprinting calls the warning
names appear in Gryphon. `os.release()`/`os.platform()` are used only to branch
platform-specific code, and nothing derived from them is transmitted.

## Environment variables

**Why:** Gryphon reads the provider API-key variables you may have set
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`) as a convenience so you
need not re-enter a key already in your environment, and standard path variables
(`PATH`, `APPDATA`, `LOCALAPPDATA`) for cross-platform CLI discovery.

**Bounds:** API keys are used only to authenticate the request to the provider
you chose and are never logged, stored in the vault, or sent anywhere else. No
identity variables (user/host) are read.

---

*Vault reads and writes go through the Obsidian API and are reported as **Pass**.
The above are the intended, bounded capabilities that a security-conscious
runtime guardrail for coding CLIs necessarily has.*
