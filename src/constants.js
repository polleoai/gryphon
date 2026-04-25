/**
 * Gryphon constants.
 *
 * TOOL_STATUS_CORE covers the built-in tool names (shared by the SDK
 * tool loop and the local CLI adapter). Consuming plugins that add
 * MCP tools merge their own status map via the view's
 * options.extraToolStatus hook.
 */

// Tool names → user-friendly status messages
const TOOL_STATUS_CORE = {
  "Bash": "Working...",
  "Read": "Reading...",
  "Write": "Writing...",
  "Edit": "Editing...",
  "Glob": "Searching files...",
  "Grep": "Searching content...",
  "WebSearch": "Searching the web...",
  "WebFetch": "Fetching page...",
  "Agent": "Thinking...",
  "TodoRead": "Thinking...",
  "TodoWrite": "Thinking...",
  "AskUser": "Thinking...",
};

// Default protected-path prefixes. Matched against the vault-relative
// path of every Write/Edit target — if the target path starts with one
// of these (or matches the exact string for non-trailing-slash entries),
// the permission gate overrides Safe/YOLO auto-accept and shows a
// warning modal. See permission-gate.js `kind: "protected"`.
const DEFAULT_PROTECTED_PATHS = [
  {
    pattern: ".obsidian/plugins/gryphon/",
    category: "modifies-gryphon",
    userRisk:
      "This folder holds Gryphon's own settings — your permission mode, your stored API key, and the bundled plugin code. A write here can flip Gryphon's permissions, swap your API key, or replace the plugin code that runs every time Gryphon loads.",
    explanation: "Gryphon's own config. Writing here can flip permission mode to YOLO, overwrite stored API keys, or replace Gryphon's bundled code — the single highest-impact escalation path.",
  },
  {
    pattern: ".obsidian/community-plugins.json",
    category: "modifies-editor",
    userRisk:
      "This file decides which Obsidian community plugins are turned on. A change can silently disable plugins you rely on or enable ones you didn't install — including Gryphon itself.",
    explanation: "Enables or disables every community plugin. An attacker could silently install or remove plugins across your vaults.",
  },
  {
    pattern: ".obsidian/core-plugins.json",
    category: "modifies-editor",
    userRisk:
      "This file toggles Obsidian's built-in plugins. A change can silently disable features you depend on or turn off safety-relevant ones.",
    explanation: "Toggles Obsidian's built-in core plugins. Modifying this can disable security-relevant features or re-enable ones you've turned off.",
  },
  {
    pattern: ".obsidian/workspace.json",
    category: "modifies-editor",
    userRisk:
      "This file stores your window and tab layout. There's rarely a reason to change it from a chat — a write here is almost certainly not what a normal request looks like.",
    explanation: "Obsidian's workspace layout and tab state. Rarely useful to edit programmatically; prompt-injection changes here can hide panes or open surprising views.",
  },
  {
    pattern: ".obsidian/workspace-mobile.json",
    category: "modifies-editor",
    userRisk:
      "The mobile-side version of Obsidian's window/tab layout file. Same risk as the desktop workspace file.",
    explanation: "Mobile-side workspace layout; same concern as the desktop workspace file.",
  },
  {
    pattern: ".obsidian/hotkeys.json",
    category: "modifies-editor",
    userRisk:
      "This file stores your keyboard shortcuts. Remapping everyday keys to destructive actions (e.g. mapping Enter to 'Delete note') is a subtle way to cause damage during your next normal typing.",
    explanation: "Your keyboard shortcuts. Remapping destructive actions (like Delete note) to common keys is a subtle UX attack.",
  },
  {
    pattern: ".obsidian/app.json",
    category: "modifies-editor",
    userRisk:
      "This file stores Obsidian's app-level preferences (appearance, read-only mode, attachment folder, etc.). Usually not something that needs programmatic editing.",
    explanation: "Obsidian app-level preferences (appearance, read-only mode, attachment folder, etc.). Usually not worth programmatic changes.",
  },
  {
    pattern: ".git/config",
    category: "persistent-execution",
    userRisk:
      "This is git's configuration file. A write here can tell git to run a malicious command the next time you commit, push, or pull — silent code execution on your next git operation.",
    explanation: "Git's repo config. An attacker setting `core.fsmonitor` or `credential.helper` to a malicious command gets code execution on your next git operation.",
  },
  {
    pattern: ".git/hooks/",
    category: "persistent-execution",
    userRisk:
      "Git hooks are shell scripts that run automatically on commit, push, or merge. A file placed here will execute the next time you do anything with git — silent, automatic code execution.",
    explanation: "Git hooks run shell scripts on commit / push / merge. A planted pre-commit or post-checkout hook executes the next time you run git — silent, automatic code execution.",
  },
  {
    pattern: ".claude/",
    category: "persistent-execution",
    userRisk:
      "This folder holds Claude Code's project-level settings and hooks. A file placed here can automatically run on your next Claude Code session, giving an attacker a foothold that survives this conversation.",
    explanation: "Project-level Claude Code configuration and hooks. CC's project hooks fire on tool-use events; a planted hook runs arbitrary shell on your next CC session.",
  },
  {
    pattern: ".claude/settings.json",
    category: "persistent-execution",
    userRisk:
      "This is Claude Code's hook-definitions file. Entries here run shell commands whenever Claude Code sees a tool event — which fires the next time you use Claude Code anywhere.",
    explanation: "Explicit: Claude Code's hook definitions file. Modifying its `hooks` section plants code that CC runs with your permissions on the next PreToolUse/PostToolUse event.",
  },
  {
    pattern: ".vscode/tasks.json",
    category: "persistent-execution",
    userRisk:
      "VS Code auto-runs tasks marked for folder-open. A task placed here will run the next time you open this folder in VS Code — silently, without prompting.",
    explanation: "VS Code auto-runs tasks marked `runOn: folderOpen`. A planted task executes the next time you open the folder in VS Code.",
  },
  {
    pattern: ".vscode/launch.json",
    category: "persistent-execution",
    userRisk:
      "This file controls how VS Code starts debug sessions. A modified pre-launch or post-debug task runs every time you debug — persistent code execution.",
    explanation: "VS Code debug launch configurations. A modified `preLaunchTask` or `postDebugTask` runs on every debug session.",
  },
];

// Default dangerous command patterns. Each line is a JS regex pattern
// (no surrounding slashes/flags — compiled case-insensitive). A Bash
// command matching any pattern gets the same warning modal as a
// protected-path write, overriding YOLO auto-accept.
const DEFAULT_PROTECTED_COMMANDS = [
  {
    // Cross-platform: also fires on Windows under git-bash / MSYS2 / WSL,
    // where `python`, `ruby`, `perl`, and `node` are all invokable via
    // cmd.exe / PowerShell too. No platforms tag = show on every host.
    pattern: "\\|\\s*(bash|sh|zsh|fish|tcsh|csh|ksh|python[\\d.]*|ruby|perl|node)\\b",
    category: "runs-arbitrary-code",
    userRisk:
      "A pipeline that feeds one command's output straight into a shell (or python / ruby / perl / node). This is the usual way to run code that came from somewhere else — if the \"somewhere else\" is a webpage or a data file that was fetched from the internet, it's running attacker-chosen code on your computer.",
    explanation: "Pipe-to-shell (or to a script interpreter). `command | bash` is the classic way to run arbitrary untrusted code — any pipeline ending in bash/sh/zsh/fish/tcsh/csh/ksh or python/ruby/perl/node gets flagged. `python[\\d.]*` catches version-suffixed binaries like `python3.11`.",
  },
  {
    // Indirected pipe-to-shell — catches bypasses where the shell
    // binary isn't immediately adjacent to the pipe. Covers:
    //   - path prefix: `| /bin/sh`, `| /usr/bin/bash`
    //   - quoted: `| "sh"`, `| 'sh'`
    //   - backslash-newline continuation: `|\<LF>sh`
    // The generic pipe-to-shell pattern above uses `\|\s*` which
    // requires the shell name adjacent to the pipe. Without this
    // pattern, `| /bin/sh` (the shape actual installers ship) would
    // bypass entirely. Documented as indirection-shape; kept separate
    // from the generic pattern so the user can tune them independently.
    pattern: "\\|(?:\\s|\\\\\\r?\\n)*['\"]?(?:/\\S+/)?['\"]?(bash|sh|zsh|fish|tcsh|csh|ksh|python[\\d.]*|ruby|perl|node)['\"]?\\b",
    category: "runs-arbitrary-code",
    userRisk:
      "Same as pipe-to-shell, but the shell binary is reached indirectly — via a path (`/bin/sh`), a quoted name (`\"sh\"`), or a backslash-newline line continuation. Functionally identical risk; just a different surface form.",
    explanation: "Pipe-to-shell via path/quote/continuation indirection. Closes `| /bin/sh`, `| \"sh\"`, `| 'sh'`, and `|\\<newline>sh` bypasses that sidestep the adjacency-based generic pattern.",
  },
  {
    // Pipe-to-shell via $SHELL / ${SHELL} variable. Attackers use this
    // to hide the shell name (especially in environments where static
    // scanners look for literal "bash"/"sh"). The variable expansion
    // still runs whatever the user's SHELL env var points to.
    pattern: "\\|\\s*\\$\\{?SHELL\\}?\\b",
    category: "runs-arbitrary-code",
    userRisk:
      "A pipeline feeding command output into `$SHELL` — whatever your login shell is. Same effect as piping into bash or sh directly, just disguised.",
    explanation: "Pipe-to-$SHELL variable expansion. Runs whatever the current SHELL env var points to. Same risk as `| sh`.",
  },
  {
    // Cross-platform: curl and wget exist as native binaries on modern
    // Windows (curl.exe ships with Windows 10+), and git-bash provides
    // bash. Dropping the posix restriction so the pattern is visible
    // in every host's Settings UI — the classifier always evaluated it.
    pattern: "(curl|wget)[^|]*\\|\\s*(bash|sh|zsh|fish|tcsh|csh|ksh)\\b",
    category: "runs-arbitrary-code",
    userRisk:
      "This downloads a file from the web and runs it right away with your permissions. It's how many legitimate installers work — and also how many malware attacks start.",
    explanation: "Classic `curl ... | bash` installer pattern. Downloads a remote script and runs it with your permissions — one of the most common ways attackers get code onto a target machine.",
  },
  {
    // Leading `['"]?` allows `'rm'` / `"rm"` quoted forms to match too.
    // Without the optional quote, `\brm\s+` failed on `'rm' -rf` because
    // the char after `m` is `'`, not whitespace.
    pattern: "\\b['\"]?rm['\"]?\\s+-[a-z]*r[a-z]*\\b",
    platforms: ["posix"],
    category: "destructive-operation",
    userRisk:
      "A recursive delete — removes a folder and everything inside it, permanently. Files removed this way are gone for good, not sent to the trash.",
    explanation: "Recursive delete (`rm -r`, `rm -rf`, `rm -Rrf`). Destructive, hard to reverse; catches every flag-order variant that includes a recursive flag. Tolerates quoted forms (`'rm' -rf`, `\"rm\" -rf`).",
  },
  {
    // Any `rm` invocation with at least one argument — non-recursive
    // single-file / glob deletes. Kept separate from the recursive
    // pattern above so users can tune them independently: many users
    // want recursive blocked but routine `rm tempfile` auto-allowed
    // (unchecked here, recursive stays checked). Leaves `rm` alone
    // (just prints help) and `rm --help` uncaught is fine.
    pattern: "\\b['\"]?rm['\"]?\\s+\\S",
    platforms: ["posix"],
    category: "destructive-operation",
    userRisk: "`rm` deletes the matching file(s) immediately — they are not sent to the Trash. Verify the path matches what you expect before approving.",
    explanation: "`rm <path>` (non-recursive). Same blast radius as the recursive form for the specific paths listed; kept separate because single-file deletes are common enough that some users auto-approve them while keeping the recursive rule armed. Tolerates quoted forms.",
  },
  {
    // Windows PowerShell recursive delete. `-Recurse` is the required
    // flag for tree removal; `-Force` / `-Confirm:$false` are common
    // bypass-prompts additions but aren't required for the regex to
    // match — the Recurse flag alone is the blast-radius signal.
    // Bounded repetition `{0,512}` instead of `*` to prevent ReDoS:
    // the unbounded form gives O(n²) backtracking on inputs that
    // repeat "Remove-Item " — a pathological 20KB input took ~80ms
    // in the v0.9 ReDoS test. 512 chars is more than enough for any
    // realistic Windows command between the verb and the flag.
    pattern: "\\bRemove-Item\\b[^|\\r\\n]{0,512}-Recurse\\b",
    platforms: ["windows"],
    category: "destructive-operation",
    userRisk: "PowerShell's `Remove-Item -Recurse` deletes a folder and every file inside it, permanently. It's the Windows equivalent of `rm -rf`; files are not sent to the Recycle Bin.",
    explanation: "PowerShell recursive remove (`Remove-Item -Recurse`). Windows equivalent of `rm -rf`; same blast radius.",
  },
  {
    // Any non-recursive Remove-Item. Catches the aliases `ri`, `rm`,
    // `erase`, `rmdir` (del is cmd.exe) that PowerShell ships. Same
    // separation rationale as the POSIX rm: keep narrow-scope single
    // file deletes distinct from recursive tree deletes so users can
    // tune independently.
    pattern: "\\b(Remove-Item|ri)\\s+\\S",
    platforms: ["windows"],
    category: "destructive-operation",
    userRisk: "Any `Remove-Item` deletes the matching file(s) immediately — they are not sent to the Recycle Bin. Same concern as `rm <file>` on POSIX.",
    explanation: "PowerShell `Remove-Item <path>` (non-recursive). Includes the `ri` alias.",
  },
  {
    pattern: "\\b(del|erase)\\s+\\S",
    platforms: ["windows"],
    category: "destructive-operation",
    userRisk: "cmd.exe's `del` removes the matching file immediately — it doesn't go to the Recycle Bin. Typos on the path are unrecoverable.",
    explanation: "cmd `del <path>` / `erase <path>` (non-recursive single-file delete). The recursive `/s` variant is still caught by the broader pattern above, which includes the per-flag warning.",
  },
  {
    // cmd.exe `del /s` walks into subdirectories. Catches `del /s`,
    // `del /S`, `erase /s`, and flag-cluster variants like `del /s /q`.
    pattern: "\\b(del|erase)\\s+[^|\\r\\n]{0,512}\\/[sS]\\b",
    platforms: ["windows"],
    category: "destructive-operation",
    userRisk: "cmd.exe's `del /s` deletes every matching file across every subdirectory. Fast, silent, and hard to undo.",
    explanation: "cmd `del /s` / `erase /s` — recursive file delete across subdirectories.",
  },
  {
    // cmd.exe tree removal. `rd /s` / `rmdir /s` deletes a directory
    // and everything under it; `/q` suppresses the confirm prompt.
    pattern: "\\b(rd|rmdir)\\s+[^|\\r\\n]{0,512}\\/[sS]\\b",
    platforms: ["windows"],
    category: "destructive-operation",
    userRisk: "cmd.exe's `rd /s` removes a directory tree. Windows equivalent of `rm -rf`.",
    explanation: "cmd `rd /s` / `rmdir /s` — recursive directory removal.",
  },
  {
    // `format D:` — filesystem-level wipe of an entire drive letter.
    // Guard against `formatting` inside a comment by requiring a drive.
    pattern: "\\bformat\\s+[A-Za-z]:",
    platforms: ["windows"],
    category: "destructive-operation",
    userRisk: "`format <drive>:` erases an entire drive and rebuilds its filesystem. Every file on that drive is gone — there is no recovery step.",
    explanation: "Windows `format <drive>:` — filesystem-level wipe of a whole drive.",
  },
  {
    // PowerShell equivalent of `format`. Wipes filesystem metadata.
    pattern: "\\bFormat-Volume\\b",
    platforms: ["windows"],
    category: "destructive-operation",
    userRisk: "PowerShell's `Format-Volume` wipes a volume at the filesystem level. Everything on that volume is lost.",
    explanation: "PowerShell `Format-Volume` — filesystem-level wipe of a volume.",
  },
  {
    // Pipe to PowerShell Invoke-Expression — Windows equivalent of
    // `| bash`. Runs whatever text comes in as PowerShell code.
    pattern: "\\|\\s*(Invoke-Expression|iex)\\b",
    platforms: ["windows"],
    category: "runs-arbitrary-code",
    userRisk: "Pipes command output into PowerShell's Invoke-Expression (`iex`), which executes arbitrary PowerShell code. Windows equivalent of `| bash`.",
    explanation: "Pipe to PowerShell `Invoke-Expression` / `iex`. Runs whatever text comes in as code — the Windows counterpart of `| bash`.",
  },
  {
    // Web-download-and-execute. The PowerShell malware-delivery pattern:
    // `iwr <url> | iex`, also covers curl/wget piped to iex.
    pattern: "\\b(Invoke-WebRequest|iwr|Invoke-RestMethod|irm|curl|wget)\\b[^|]{0,1024}\\|\\s*(Invoke-Expression|iex)\\b",
    platforms: ["windows"],
    category: "runs-arbitrary-code",
    userRisk: "Downloads content from the web and runs it through PowerShell. One of the most common Windows malware delivery patterns — directly equivalent to `curl | bash`.",
    explanation: "PowerShell remote-download-and-execute: `iwr <url> | iex`, `irm <url> | iex` (Invoke-RestMethod alias), or curl/wget piped to iex. Classic Windows-malware installer shape.",
  },
  {
    // Windows registry modification via reg.exe. Covers persistent
    // startup hooks (Run keys), autorun changes, and settings-plant.
    pattern: "\\breg\\s+(delete|add|import)\\b",
    platforms: ["windows"],
    category: "persistent-execution",
    userRisk: "Modifies the Windows registry. Registry changes can survive reboots, alter which programs run at startup, and affect other installed software.",
    explanation: "Windows registry mutation via `reg.exe` (`reg add` / `reg delete` / `reg import`). Persistent — commonly used for startup-hook plants.",
  },
  {
    // PowerShell registry mutation via Set-Item / Set-ItemProperty on
    // an HK* provider path. Same concern as `reg add`.
    pattern: "\\bSet-Item(Property)?\\b[^|\\r\\n]{0,512}HK(LM|CU|CR|U|CC):",
    platforms: ["windows"],
    category: "persistent-execution",
    userRisk: "Modifies the Windows registry via PowerShell. Registry changes can survive reboots and affect how the system or other programs behave.",
    explanation: "PowerShell registry mutation (`Set-Item` / `Set-ItemProperty` targeting HKLM/HKCU/HKCR/HKU/HKCC). Same blast radius as `reg add`.",
  },
  {
    pattern: "(>|>>|tee)\\s+\\S*\\.(obsidian|git|claude|vscode)[/\\\\]",
    category: "persistent-execution",
    userRisk:
      "A shell redirect (`>`, `>>`, or `tee`) that writes directly into a protected settings folder — Obsidian, git, Claude Code, or VS Code. This is the \"back door\" way to change those settings or plant hidden code without Gryphon's normal file-write check seeing it.",
    explanation: "Shell redirect into Obsidian / git / Claude Code / VS Code config directories. Bypasses the protected-path file check by going through a shell redirect rather than the Write tool.",
  },
  {
    pattern: "(>|>>|tee)\\s+\\S*(~/\\.claude|~/\\.config/|~/\\.ssh/|~/\\.bashrc|~/\\.zshrc|~/\\.profile|/etc/|/usr/|/System/|/var/)",
    platforms: ["posix"],
    category: "accesses-system",
    userRisk:
      "A shell redirect that writes outside your vault into a sensitive spot — a system directory (like `/etc` or `/usr`), a hidden settings folder in your home (`~/.config`, `~/.claude`), your SSH keys folder (`~/.ssh`), or a shell startup file (`~/.bashrc`, `~/.zshrc`, `~/.profile`). These either affect your whole computer, your other Claude sessions, or run automatically the next time you open a terminal.",
    explanation: "Shell redirect into user-level or system-level critical paths. Covers `~/.claude/` (Claude Code user hooks), `~/.ssh/` (classic `authorized_keys` backdoor), shell rc files (`~/.bashrc` / `~/.zshrc` / `~/.profile` — run on every new shell), and major system directories. These live outside any vault, so path validation can't reach them — command-pattern matching is the only defense.",
  },
  {
    // Windows equivalent of the POSIX redirect-into-system pattern.
    // `\S{0,512}` bounded so an adversarial 64KB input of non-whitespace
    // junk can't catastrophically backtrack. The match targets the
    // last path separator before a sensitive directory name.
    pattern: "(>|>>|tee)\\s+\\S{0,512}[/\\\\](AppData|Windows|ProgramData|System32|Program Files|\\.claude)[/\\\\]",
    platforms: ["windows"],
    category: "accesses-system",
    userRisk:
      "A shell redirect that writes into a Windows system, user-profile, or Claude Code configuration directory (like `AppData`, `Windows`, `ProgramData`, `System32`, `Program Files`, or `.claude`). These paths sit outside your Obsidian vault and can affect your whole computer, or your other Claude sessions.",
    explanation: "Shell redirect into Windows-critical paths — AppData (per-user app state), Windows/System32 (OS), ProgramData (shared app state), Program Files (installed software), and `.claude` (Claude Code user hooks). Files written here escape vault-boundary checks, so command-pattern matching is the only defense.",
  },
  {
    pattern: "\\bschtasks\\s+\\/(create|change|delete)\\b",
    platforms: ["windows"],
    category: "persistent-execution",
    userRisk:
      "`schtasks` manages Windows scheduled tasks. Creating or modifying one schedules code to run later — on a timer, on logon, or on a system event — outside this conversation where you can see it.",
    explanation: "Windows `schtasks /create|/change|/delete`. Scheduled-task install / modify / remove. A favored persistence technique on Windows.",
  },
  {
    pattern: "\\b(Register|Set|Unregister)-ScheduledTask\\b",
    platforms: ["windows"],
    category: "persistent-execution",
    userRisk:
      "PowerShell cmdlets that install, modify, or remove Windows scheduled tasks. The scheduled code runs later — on a timer, on logon, or on a system event — outside this conversation.",
    explanation: "PowerShell `Register-ScheduledTask` / `Set-ScheduledTask` / `Unregister-ScheduledTask`. Same persistence concern as `schtasks`.",
  },
  {
    pattern: "\\bStart-Process\\b[\\s\\S]{0,512}-Verb\\s+(['\"]?)RunAs\\1\\b",
    platforms: ["windows"],
    category: "escalates-privileges",
    userRisk:
      "Launches a new process with administrator rights via a UAC prompt. On approval, the new process runs with full admin privileges — the Windows counterpart of `sudo`.",
    explanation: "PowerShell `Start-Process ... -Verb RunAs` triggers a UAC elevation prompt. Windows equivalent of `sudo`; rarely needed from a chat context. Cross-line match (`[\\s\\S]`) catches backtick-continuation style. Optional quote wrapping catches `-Verb 'RunAs'` / `-Verb \"RunAs\"`.",
  },
  {
    pattern: "\\bsc\\.exe\\s+(create|config|delete)\\b",
    platforms: ["windows"],
    category: "persistent-execution",
    userRisk:
      "`sc.exe create` installs a new Windows service; `config` changes an existing one; `delete` removes one. Services survive reboots and can run at startup with elevated privileges — a classic persistence mechanism.",
    explanation: "Windows Service Control (`sc.exe create|config|delete`). Services persist across reboots and commonly run as SYSTEM.",
  },
  {
    pattern: "\\bNew-Service\\b",
    platforms: ["windows"],
    category: "persistent-execution",
    userRisk:
      "`New-Service` installs a new Windows service via PowerShell. Services survive reboots and can run at startup — same persistence concern as `sc.exe create`.",
    explanation: "PowerShell `New-Service`. Service install via cmdlet; same blast radius as `sc.exe create`.",
  },
  {
    // PowerShell native file-write cmdlets, targeted at AppData /
    // Windows / ProgramData / System32 / Program Files / .claude.
    // The earlier `(>|>>|tee) \S* …` redirect pattern caught classic
    // shell redirects, but PowerShell's `Set-Content`, `Out-File`,
    // `Add-Content`, `Export-Clixml` write to the same locations
    // without any redirect operator. Without this rule, an attacker
    // could reach protected system paths by running
    // `Set-Content -Path $env:APPDATA\Claude\settings.json -Value ...`
    // without any pattern firing.
    pattern: "\\b(Set-Content|Out-File|Add-Content|Export-Clixml)\\b[^\\r\\n]{0,512}[/\\\\](AppData|Windows|ProgramData|System32|Program Files|\\.claude)[/\\\\]",
    platforms: ["windows"],
    category: "accesses-system",
    userRisk:
      "PowerShell is writing to a Windows system, user-profile, or Claude Code configuration directory (`AppData`, `Windows`, `ProgramData`, `System32`, `Program Files`, `.claude`) via a native cmdlet. Same blast radius as a `>` redirect — can affect your whole computer or your other Claude sessions.",
    explanation: "PowerShell native-cmdlet write into Windows-critical paths. Covers `Set-Content`, `Out-File`, `Add-Content`, `Export-Clixml`. Pairs with the `>`/`>>`/`tee` pattern so cmdlet-style writes don't sneak past the system-path guard.",
  },
  {
    // schtasks /run — executes an ALREADY-installed scheduled task
    // on demand. The earlier pattern only caught create/change/delete,
    // but an attacker who planted a task earlier (or a pre-existing
    // task on the machine) can invoke malicious code via /run.
    pattern: "\\bschtasks\\s+\\/run\\b",
    platforms: ["windows"],
    category: "runs-arbitrary-code",
    userRisk:
      "`schtasks /run` triggers an already-installed Windows scheduled task immediately. If the task points at malicious code, running it via this command bypasses the \"scheduled later\" signal — it's effectively arbitrary-code-execution through the task scheduler.",
    explanation: "Windows `schtasks /run <name>` — executes a pre-existing task on demand. Pairs with the `/create|/change|/delete` rule so task-execution is also guarded, not just task-installation.",
  },
  {
    // Shell wrappers: `env bash`, `/usr/bin/env bash` pattern where
    // the interpreter isn't at position 1 of the pipe tail. The
    // original `\|\s*(bash|sh|...)` misses `cmd | env bash` because
    // `env` sits between `|` and `bash`.
    pattern: "\\|\\s*(/usr/bin/)?env\\s+(bash|sh|zsh|fish|tcsh|csh|ksh|python[\\d.]*|ruby|perl|node)\\b",
    category: "runs-arbitrary-code",
    userRisk:
      "A pipeline feeding command output into `env <interpreter>`. Same as piping directly into the interpreter — attacker-chosen code runs with your permissions. The `env` wrapper is a common way to find the interpreter on PATH without an absolute path.",
    explanation: "Pipe-to-shell via `env` wrapper. Covers `| env bash`, `| /usr/bin/env python3`, etc. Closes the gap where the interpreter name isn't adjacent to the pipe.",
  },
  {
    pattern: "\\bchmod\\s+\\+x\\b",
    platforms: ["posix"],
    category: "persistent-execution",
    userRisk:
      "Marks a file as executable. Usually a step in a pattern where a script is written and then run. By itself harmless, but rarely needed in a normal chat.",
    explanation: "Marking a file executable. Classic step in a dropper sequence (write script → chmod +x → run). Rarely legitimate in prompt-driven workflows.",
  },
  {
    pattern: "\\bgit\\s+(config|hooks)\\b",
    category: "persistent-execution",
    userRisk:
      "Modifies git's configuration or hooks. Once changed, the malicious settings stay and fire automatically on your next git operation (commit, push, pull) — silent, persistent code execution.",
    explanation: "Modifying git config or hooks via the git command. Sets up hook-based RCE that fires on your next git operation.",
  },
  {
    pattern: "\\b(sudo|su|doas|pkexec)\\b",
    platforms: ["posix"],
    category: "escalates-privileges",
    userRisk:
      "A command asking for administrator access to your computer. Very few normal chat requests need admin — mainly installers or system tweaks.",
    explanation: "Privilege escalation attempt. Covers sudo (Linux/macOS), su (switch user), doas (OpenBSD), pkexec (polkit). No chat-driven workflow needs to elevate; approve only if you're deliberately running an installer.",
  },
  {
    pattern: "\\beval\\b",
    platforms: ["posix"],
    category: "runs-arbitrary-code",
    userRisk:
      "`eval` takes a string and runs it as a fresh shell command. Whatever string follows — possibly constructed from attacker-controlled data — becomes the command. Very rarely legitimate.",
    explanation: "`eval` runs its argument as shell code. Rarely legitimate outside shell scripts; a top signal of attempted arbitrary-code execution.",
  },
  {
    // Cross-platform: a user on Windows with git-bash installed can run
    // `bash -c "..."` just as easily as on POSIX. Dropping the platforms
    // filter so the pattern is visible (and tunable) from every host.
    pattern: "\\b(bash|sh|zsh|fish|tcsh|csh|ksh)\\s+-c\\b",
    category: "runs-arbitrary-code",
    userRisk:
      "Running a shell with `-c` executes whatever inline script follows. Same risk as piping into a shell — just a different syntax for running the same kind of untrusted code.",
    explanation: "Shell with `-c` runs an inline script (e.g. `bash -c \"...\"`). Equivalent to pipe-to-shell at a different syntax.",
  },
  {
    // Loosened adjacency from the original `\s+(-c|-e)\b` — the tight
    // form missed `perl -Mstrict -e '...'`, `python3.11 -c '...'`,
    // `node --eval '...'`, and any other loader-flag-before-eval
    // variant. `[^|\r\n]{0,128}` bounds backtracking (ReDoS-safe).
    // `python[\d.]*` catches version-suffixed binaries.
    pattern: "\\b(python[\\d.]*|ruby|perl|node)(\\.exe)?\\b[^|\\r\\n]{0,128}\\s-(c|e|-eval)\\b",
    category: "runs-arbitrary-code",
    userRisk:
      "Running python, ruby, perl, or node with `-c`, `-e`, or `--eval` tells it to run whatever code follows right there in the command. Same risk as `bash -c` — any code chosen by whoever set it up runs with your permissions.",
    explanation: "Script interpreter running inline code (`python -c`, `node -e`, `perl -e`, `node --eval`, and loader-prefixed variants like `perl -Mstrict -e`). Same threat surface as `bash -c`.",
  },
  {
    // Interpreter reading stdin (`python < script.py`, `ruby < foo.rb`).
    // Equivalent to pipe-to-shell from a file — arbitrary code executes.
    // The existing `| python` pattern catches the pipe form; this catches
    // the redirect form.
    pattern: "\\b(python[\\d.]*|ruby|perl|node)(\\.exe)?\\b\\s+<\\s*\\S",
    category: "runs-arbitrary-code",
    userRisk:
      "An interpreter reading its script from stdin redirection (`python < file`). The contents of `file` run as code with your permissions — same risk as `python -c` with the contents inline.",
    explanation: "Script interpreter with stdin redirection. `python < script.py` is functionally identical to running the script; the classifier flags the redirect form because the file contents are arbitrary code.",
  },
  {
    // Process substitution: `bash <(curl ...)` runs the output of the
    // subprocess as a script. Sidesteps the pipe-to-shell family.
    pattern: "\\b(bash|sh|zsh|fish|tcsh|csh|ksh)\\s+<\\(",
    category: "runs-arbitrary-code",
    userRisk:
      "A shell running the output of another command as a script via process substitution (`bash <(curl ...)`). Same risk as `curl | bash` — attacker-chosen code runs with your permissions.",
    explanation: "Process substitution feeding a shell: `bash <(<cmd>)`, `sh <(...)`. The subprocess's stdout becomes the shell's input script.",
  },
  {
    pattern: "\\bxargs\\b",
    platforms: ["posix"],
    category: "runs-arbitrary-code",
    userRisk:
      "`xargs` runs a command for every line of its input. If that input came from a file or a web page, xargs effectively becomes a loop that runs attacker-chosen commands.",
    explanation: "`xargs` runs a command for every input line. If the input list is attacker-controlled (e.g. piped from a fetched file), xargs becomes an arbitrary-execution loop.",
  },
  {
    pattern: "-exec\\b",
    platforms: ["posix"],
    category: "runs-arbitrary-code",
    userRisk:
      "`find -exec` runs the given command for every matched file. The same command can execute dozens or hundreds of times, possibly over sensitive files.",
    explanation: "`find -exec` runs the given command on every match. Equivalent to a loop of arbitrary execution over file paths.",
  },
  {
    pattern: "\\bssh\\s+\\S+\\s+\\S",
    category: "network-exec",
    userRisk:
      "An ssh command with a remote command attached — runs that command on another computer using your ssh credentials. An interactive `ssh host` on its own is fine; this form is different, because the remote command is fixed in advance.",
    explanation: "ssh with a remote command argument (`ssh host 'cmd'`). Runs `cmd` on another machine with your credentials. Interactive `ssh host` alone is not flagged.",
  },
  {
    pattern: "\\b(nohup|setsid)\\b",
    platforms: ["posix"],
    category: "persistent-execution",
    userRisk:
      "`nohup` and `setsid` let a command keep running after you close your terminal or log out. A common way to hide a long-running process that an attacker would want to keep alive after you stop paying attention.",
    explanation: "`nohup` and `setsid` detach a command from the current session so it survives logout. Commonly used to persist payloads.",
  },
  {
    pattern: "\\b(at|batch|crontab)\\b",
    platforms: ["posix"],
    category: "persistent-execution",
    userRisk:
      "Schedules code to run later — outside this conversation where you can see it. Attackers like this because the code fires when you're not watching, sometimes hours or days later.",
    explanation: "Schedulers (`at`, `batch`, `crontab`) queue arbitrary code to run later — outside your current review. A favored persistence technique.",
  },
  // ──────────────────────────────────────────────────────────────────
  // network-fetch category — any command that pulls content from the
  // internet. In a knowledge-management + AI-agent context, a download
  // is rarely the user's actual goal; it's far more often the first
  // step of an attack shape (download + execute) or of unexpected data
  // exfiltration. We use URL presence (`://`) as the discriminator so
  // legitimate env-probing commands like `curl --version`, `which
  // curl`, `grep curl file.md` don't fire. See docs/adr/0001 for the
  // threat-model rationale (sharpened during v0.9 pattern-hardening).
  // ──────────────────────────────────────────────────────────────────
  {
    pattern: "\\bcurl\\b[^|\\r\\n]{0,512}://",
    category: "network-fetch",
    userRisk:
      "`curl` with a URL fetches content from the internet. In an Obsidian knowledge-management session, downloading from the web is rarely the user's actual goal — it's more often the first step of a download-and-execute shape. Approve if you specifically asked for it; otherwise this is suspicious.",
    explanation: "Bare `curl` invocation with a URL. Caught regardless of whether it pipes into a shell or writes to disk — the network fetch itself is the signal.",
  },
  {
    pattern: "\\bwget\\b[^|\\r\\n]{0,512}://",
    category: "network-fetch",
    userRisk:
      "`wget` with a URL fetches content from the internet. Same concern as `curl http://...` — download-and-execute patterns start with a fetch.",
    explanation: "Bare `wget` invocation with a URL.",
  },
  {
    pattern: "\\b(Invoke-WebRequest|iwr|Invoke-RestMethod|irm)\\b[^|\\r\\n]{0,512}://",
    platforms: ["windows"],
    category: "network-fetch",
    userRisk:
      "PowerShell web cmdlet with a URL — `Invoke-WebRequest` (`iwr`) or `Invoke-RestMethod` (`irm`) fetches content from the internet. Common first step in Windows malware delivery.",
    explanation: "Bare PowerShell download cmdlet with a URL argument. Covers the non-pipe forms the existing `iwr|iex` pattern misses.",
  },
  {
    pattern: "\\bStart-BitsTransfer\\b",
    platforms: ["windows"],
    category: "network-fetch",
    userRisk:
      "`Start-BitsTransfer` uses the Windows Background Intelligent Transfer Service to download a file. A less-observed download primitive favored for low-profile persistence. Rarely legitimate in a chat-driven workflow.",
    explanation: "PowerShell BITS download. Fetches files via the Windows BITS service, bypasses many HTTP-monitoring hooks.",
  },
  {
    pattern: "\\bNew-Object\\s+[^|\\r\\n]{0,64}Net\\.WebClient\\b",
    platforms: ["windows"],
    category: "network-fetch",
    userRisk:
      "Creating a `.NET` `WebClient` object is the first half of the classic `(New-Object Net.WebClient).DownloadString(...)` malware pattern. Pairs with a `.DownloadString()` / `.DownloadFile()` / `IEX` call to become download-and-execute.",
    explanation: "Instantiating `System.Net.WebClient` / `Net.WebClient` in PowerShell. Flagged at creation because the download methods follow inline.",
  },
  {
    pattern: "\\bcertutil(\\.exe)?\\b[^|\\r\\n]{0,512}-urlcache\\b",
    platforms: ["windows"],
    category: "network-fetch",
    userRisk:
      "`certutil -urlcache` downloads a file from a URL and caches it locally. Intended for cert management, but widely abused as a living-off-the-land download primitive because it bypasses naïve \"no curl\" restrictions.",
    explanation: "Windows `certutil` abused as a downloader via its `-urlcache` flag. Classic LOLBin pattern.",
  },
  {
    pattern: "\\b(fetch|axel|aria2c)\\b[^|\\r\\n]{0,512}://",
    platforms: ["posix"],
    category: "network-fetch",
    userRisk:
      "A BSD-era or alternative downloader (`fetch`, `axel`, `aria2c`) with a URL. Same concern as `curl` / `wget` — content from the internet is arriving on your machine.",
    explanation: "Less-common POSIX downloaders. Covers FreeBSD's `fetch` and the common multi-connection downloaders `axel` and `aria2c`.",
  },
  {
    pattern: "(\\bsource\\s+\\S+|(^|\\s)[.&]\\s+\\S+\\.(sh|bash|zsh|ps1|psm1))",
    category: "runs-arbitrary-code",
    userRisk:
      "Reads a script and runs it in your current shell session — including any functions, aliases, or path changes it defines. Covers POSIX `source`/`. script.sh` AND PowerShell dot-source (`. script.ps1`) and invoke-operator (`& script.ps1`). If the script is attacker-controlled, those changes persist for the rest of the session.",
    explanation: "Script loading into the current session: `source file`, `. file.sh` (POSIX), `. file.ps1` / `& file.ps1` (PowerShell). Reads arbitrary file contents and runs them.",
  },
  {
    // PowerShell Invoke-Expression standalone — catches the non-pipe
    // forms the existing `\|\s*iex` pattern misses. Real malware uses
    // `IEX (New-Object Net.WebClient).DownloadString(...)` or
    // `$x = irm ...; iex $x` more often than the pipe form, because
    // those shapes play nicer with `-EncodedCommand` payloads.
    // Matching bare IEX/Invoke-Expression catches all these forms.
    pattern: "\\b(IEX|Invoke-Expression)\\b",
    platforms: ["windows"],
    category: "runs-arbitrary-code",
    userRisk:
      "`Invoke-Expression` / `IEX` runs arbitrary PowerShell code passed as a string. It's the single most-abused primitive in Windows malware — used in `IEX (New-Object Net.WebClient).DownloadString(...)` and similar download-and-execute shapes. Rarely legitimate in a knowledge-management session.",
    explanation: "PowerShell `Invoke-Expression` / `IEX` — evaluates a string as PowerShell code. Catches the non-pipe forms (`IEX (...)`, `$x = irm; iex $x`) that sidestep the pipe-to-iex pattern.",
  },
  {
    // powershell -c / -e / -EncodedCommand / -Command invocations.
    // The `-EncodedCommand` form ships base64-encoded PowerShell
    // which is unreadable in the command view — opaque to review.
    // `-c` / `-Command` / prefix abbreviations all accept inline code.
    // Case-insensitive flag already handles `-C` / `-E` variants.
    pattern: "\\b(powershell|pwsh)(\\.exe)?\\s+-(c|com|comm|comma|comman|command|e|en|enc|enco|encod|encode|encoded|encodedc|encodedco|encodedcom|encodedcomm|encodedcomma|encodedcomman|encodedcommand)\\b",
    platforms: ["windows"],
    category: "runs-arbitrary-code",
    userRisk:
      "Launches PowerShell to run inline code (`-Command`) or a base64-encoded payload (`-EncodedCommand`). The encoded form is particularly concerning — it's unreadable in the command view, so whatever it runs is invisible to you at the approval moment.",
    explanation: "PowerShell CLI with inline-code flag: `-Command`, `-EncodedCommand`, or any unambiguous prefix abbreviation. Covers `powershell -c`, `pwsh -enc`, `powershell.exe -Command`, etc.",
  },
  // ──────────────────────────────────────────────────────────────────
  // Target-based widening — file-write/mutation primitives that target
  // paths outside the vault via cp/mv/ln/install/sed-i, the PowerShell
  // equivalents on Windows system dirs, destructive alternatives to
  // rm (shred/truncate/dd/find-delete/unlink), and wider registry-
  // write coverage. Added during the v0.9 pattern-hardening arc
  // (docs/adr/0001). Before these, `cp /tmp/x /etc/passwd` bypassed
  // protection that `> /etc/passwd` already caught — the shape
  // differs, the threat doesn't.
  // ──────────────────────────────────────────────────────────────────
  {
    pattern: "\\b(cp|mv|ln|install)\\b[^|\\r\\n]{0,512}\\s(~/\\.claude|~/\\.config/|~/\\.ssh/|~/\\.bashrc|~/\\.zshrc|~/\\.profile|/etc/|/usr/|/System/|/var/|/root/)",
    platforms: ["posix"],
    category: "accesses-system",
    userRisk:
      "A file copy / move / link / install targeting a sensitive system directory — `/etc/`, `/usr/`, `/System/`, `/var/`, `/root/`, or a hidden settings folder like `~/.ssh/`, `~/.bashrc`, `~/.claude/`. These paths affect your whole computer, your other Claude sessions, or run automatically the next time you open a terminal.",
    explanation: "File-write primitives (cp, mv, ln, install) targeting POSIX system/critical paths. Mirrors the existing redirect-to-sensitive-dir pattern for the shape where the path is an argument rather than a redirect target.",
  },
  {
    pattern: "\\bsed\\s+-i\\S*\\s+[^|\\r\\n]{0,512}(~/\\.claude|~/\\.config/|~/\\.ssh/|~/\\.bashrc|~/\\.zshrc|~/\\.profile|/etc/|/usr/|/System/|/var/|/root/)",
    platforms: ["posix"],
    category: "accesses-system",
    userRisk:
      "In-place editing of a file in a sensitive system directory via `sed -i`. Same blast radius as writing over `/etc/passwd` — changes persist and can affect system behavior or other Claude sessions.",
    explanation: "`sed -i` in-place edit targeting POSIX system/critical paths. Covers `sed -i`, `sed -i ''` (macOS form), `sed -i.bak`, etc.",
  },
  {
    pattern: "\\b(Copy-Item|Move-Item|New-Item|Rename-Item)\\b[^|\\r\\n]{0,512}[/\\\\](AppData|Windows|ProgramData|System32|Program Files|\\.claude)[/\\\\]",
    platforms: ["windows"],
    category: "accesses-system",
    userRisk:
      "A PowerShell file-mutation cmdlet (`Copy-Item`, `Move-Item`, `New-Item`, `Rename-Item`) targeting a sensitive Windows directory. Same concerns as the redirect-into-AppData/Windows rule, just for the shape where the path is an argument.",
    explanation: "PowerShell file-write cmdlets targeting Windows system/critical paths. Mirrors the existing `Set-Content` / `Out-File` / `Add-Content` rule for copy/move/new/rename operations.",
  },
  {
    pattern: "\\b(Copy-Item|New-Item|New-ItemProperty)\\b[^|\\r\\n]{0,512}HK(LM|CU|CR|U|CC):",
    platforms: ["windows"],
    category: "persistent-execution",
    userRisk:
      "A PowerShell cmdlet writing to the Windows registry. Like `reg add`, registry changes can survive reboots and affect which programs run at startup or how the system behaves.",
    explanation: "PowerShell registry mutation via `Copy-Item`, `New-Item`, or `New-ItemProperty` targeting an `HK*:` provider path. Complements the existing `Set-Item` / `Set-ItemProperty` rule.",
  },
  {
    pattern: "\\b(shred|unlink)\\b",
    platforms: ["posix"],
    category: "destructive-operation",
    userRisk:
      "`shred` overwrites a file's contents multiple times before removing it — unrecoverable by forensic tools. `unlink` removes the file-to-name link immediately, same blast radius as `rm` for the named file. Both are destructive; files do not go to the Trash.",
    explanation: "Alternative destructive primitives. `shred` is intentional forensic-proof deletion; `unlink` is the raw POSIX syscall wrapper.",
  },
  {
    pattern: "\\btruncate\\s+-s\\s+0\\b",
    platforms: ["posix"],
    category: "destructive-operation",
    userRisk:
      "`truncate -s 0 <file>` wipes the file's contents to zero bytes. Functionally a destructive write — previous contents are lost.",
    explanation: "`truncate -s 0` zeroes a file's contents without unlinking it. Common legitimately in log-rotation scripts, but destructive when applied to arbitrary files.",
  },
  {
    // Narrow to real block devices. `/dev/null` (discard) and
    // `/dev/zero` (read-only — can't be `of=`) are routine idioms and
    // shouldn't fire. Match the common device-name families:
    // sd* (SCSI/SATA), hd* (legacy IDE), nvme* (NVMe), disk*/rdisk*
    // (macOS), md* (Linux RAID), loop*, xvd*/vd* (Xen/virtio),
    // mmcblk* (SD card).
    pattern: "\\bdd\\b[^|\\r\\n]{0,512}\\bof=/dev/(sd|hd|nvme|disk|rdisk|md|loop|xvd|vd|mmcblk)",
    platforms: ["posix"],
    category: "destructive-operation",
    userRisk:
      "`dd` writing to a raw disk or partition device (e.g. `/dev/sda`, `/dev/nvme0n1`, `/dev/disk2`) can wipe or corrupt the storage device. This is one of the few commands that can render the system unbootable if pointed at the wrong device.",
    explanation: "`dd if=... of=/dev/<block-device>` — raw write to a storage device. Narrowed to common device families so legitimate `of=/dev/null` discards don't false-fire. Catastrophic when misaimed; the blast radius is system-level.",
  },
  {
    pattern: "\\bfind\\b[^|\\r\\n]{0,512}-delete\\b",
    platforms: ["posix"],
    category: "destructive-operation",
    userRisk:
      "`find ... -delete` removes every file that matches the criteria in a single pass. The match set can be large and hard to review — one typo in the filter can delete much more than intended.",
    explanation: "`find -delete` — bulk deletion of every match. Equivalent in blast radius to `rm -rf` over a filter.",
  },
  // ──────────────────────────────────────────────────────────────────
  // Windows LOLBins (Living-Off-The-Land Binaries) — legitimate Windows
  // utilities that attackers abuse as execution / download / bypass
  // primitives. Added during v0.9 pattern-hardening (docs/adr/0001);
  // each is rarely used in knowledge-management workflows but heavily
  // used by real Windows malware per MITRE ATT&CK.
  // ──────────────────────────────────────────────────────────────────
  {
    pattern: "\\bmshta(\\.exe)?\\b",
    platforms: ["windows"],
    category: "runs-arbitrary-code",
    userRisk:
      "`mshta` executes HTML Application (.hta) files, which can contain JavaScript / VBScript. Widely abused by Windows malware as a script-execution primitive that bypasses many naïve restrictions. Extremely rare in legitimate workflows.",
    explanation: "Windows `mshta` LOLBin. Runs HTA scripts inline (`mshta javascript:...`) or from a URL. MITRE ATT&CK T1218.005.",
  },
  {
    pattern: "\\brundll32(\\.exe)?\\b[^|\\r\\n]{0,256}(javascript:|://)",
    platforms: ["windows"],
    category: "runs-arbitrary-code",
    userRisk:
      "`rundll32` with a `javascript:` URL executes inline JavaScript in the Windows scripting host — a bypass primitive that sidesteps many AV hooks. The URL variant (`rundll32 <url>`) is a download-and-execute shape.",
    explanation: "Windows `rundll32` LOLBin abuse — `javascript:` URL handler or remote-URL loader. Catches `rundll32.exe javascript:alert(1)` and URL-based variants. Legitimate `rundll32 user32.dll,LockWorkStation` uses are unaffected.",
  },
  {
    pattern: "\\bregsvr32(\\.exe)?\\b[^|\\r\\n]{0,256}(scrobj\\.dll|/i:\\S+://)",
    platforms: ["windows"],
    category: "runs-arbitrary-code",
    userRisk:
      "`regsvr32` with `scrobj.dll` or `/i:<url>` runs a remote scriptlet — a well-known bypass primitive (Squiblydoo) that many AV hooks miss. The scriptlet contents come from wherever the URL points to.",
    explanation: "Windows `regsvr32` Squiblydoo bypass. MITRE ATT&CK T1218.010. Normal `regsvr32 some.dll` for legitimate COM registration is unaffected.",
  },
  {
    pattern: "\\bwmic\\b[^|\\r\\n]{0,256}\\bcall\\s+create\\b",
    platforms: ["windows"],
    category: "runs-arbitrary-code",
    userRisk:
      "`wmic process call create` spawns an arbitrary process via WMI — effectively a shell without going through cmd.exe or PowerShell. A classic LOLBin for bypassing process-chain monitoring.",
    explanation: "Windows WMIC process creation — `wmic process call create`. MITRE ATT&CK T1047. Query-only WMIC uses (`wmic process get`) are unaffected.",
  },
  {
    pattern: "\\bpip[\\d.]*\\s+install\\b",
    category: "network-fetch",
    userRisk:
      "`pip install` downloads packages from PyPI (or an attacker-specified index) and runs their setup scripts with your permissions. Package install is rarely part of an Obsidian knowledge-management workflow — if you're setting up a dev environment, this is expected; otherwise it's a download-and-execute shape.",
    explanation: "Python package install. Runs arbitrary `setup.py` code from downloaded packages — functionally a network-fetch-to-execute primitive.",
  },
];

const DEFAULT_SETTINGS = {
  claudePath: "",
  // New default: "default" prompts on every edit and shell command.
  // Users who want the old frictionless behavior can switch to "Safe"
  // (acceptEdits — auto-accepts file edits, still prompts on bash) or
  // "YOLO" (bypassPermissions — skips all prompts) in settings.
  permissionMode: "default",
  model: "sonnet",
  effort: "high",
  openInMainTab: false,
  lastSessionId: null,
  // Provider selection. Values are identifier-tied to the provider
  // product rather than the transport mechanism, so future providers
  // (Gemini, OpenAI, local models) can be added without colliding.
  //   "anthropic-api"  — default; Anthropic's API via HTTPS (SDK-based,
  //                       uses your Anthropic API key, recommended)
  //   "claude-code"    — spawns a locally-installed `claude` binary
  //                       (Claude Code CLI; subject to that vendor's
  //                       terms of use — for users who already have
  //                       that subscription and have reviewed them)
  //   "auto"           — prefer claude-code if the binary is present,
  //                       else fall back to anthropic-api
  providerPreference: "anthropic-api",
  // Anthropic API key for Anthropic API mode. Stored in plugin data.json — users
  // who don't want a key on disk can leave this blank and set the
  // ANTHROPIC_API_KEY env var instead (the factory checks both).
  anthropicApiKey: "",
  // Brave Search API key for SDK-mode WebSearch. Free tier: 2000
  // queries/month at https://brave.com/search/api/. Empty string means
  // WebSearch returns an instructive error telling the user how to set it.
  braveSearchApiKey: "",
  // Holds the compaction summary produced by /compact, consumed by the
  // NEXT process spawn via --append-system-prompt. Cleared after first use.
  compactionSummary: null,
  // Upper bound (in megabytes) for SDK-mode Read and Edit tool calls.
  // Obsidian's Electron renderer has less heap than Node's 2 GB default,
  // so an uncapped Read on a 500 MB log file would OOM. 10 MB is generous
  // for text content; raise it if you routinely work with large .canvas
  // or .json files and accept the slower load.
  maxReadFileSizeMb: 10,
  // Master toggles for the two protection features. When true (default),
  // the per-pattern checklist below is enforced; when false, the whole
  // feature is bypassed and classify() returns null for that kind. Users
  // who want protection off entirely flip the master toggle rather than
  // unchecking each default pattern one by one. Existing per-pattern
  // selections are preserved while the master toggle is off so users
  // can flip protection back on without losing their customizations.
  protectedPathsEnabled: true,
  protectedCommandsEnabled: true,
  // Default patterns the user has turned off via the checklist. These are
  // strings that appear in DEFAULT_PROTECTED_PATHS — only defaults can
  // be "disabled" (to remove a custom, delete it entirely).
  protectedPathsDisabled: [],
  // User-added protected paths. Always active when present. Free-form
  // strings following the same prefix / exact-match rules as the defaults
  // (trailing `/` = prefix, otherwise exact).
  protectedPathsCustom: [],
  // Same structure for Bash command patterns. Custom entries must be
  // valid JavaScript regex (case-insensitive) — validated on add.
  protectedCommandsDisabled: [],
  protectedCommandsCustom: [],
  // Protected Mode — master toggle for the protected-pattern policy.
  //
  //   true  (default): Protected Mode is up. Protected paths / commands trigger
  //                    a response. The `autoDenyProtected` sub-toggle
  //                    decides which response:
  //                      - false (default): approve/deny modal fires
  //                      - true           : refuse outright, no modal
  //   false          : Protected Mode is down. Protected patterns are NOT
  //                    enforced. Paths / commands matching the list
  //                    are treated exactly like any other op — the
  //                    permission mode (Prompt / Safe / YOLO) governs
  //                    entirely. This is the path to "real YOLO" with
  //                    no pattern-based overrides.
  //
  // Behaves identically across SDK and CLI providers. The enforcement
  // mechanism differs (SDK uses in-process permission-gate; CLI uses
  // hooks or a permissions.deny settings file), but the user-visible
  // outcome is the same for any given setting combination.
  //
  // Legacy name `hookInstrumentation` (through v0.9.1) is migrated
  // forward in _migrateSettings.
  protectedMode: true,
  // Sub-toggle: when Protected Mode is ON, should protected matches be
  // refused automatically without an approval modal?
  //
  //   false (default): modal fires — user can approve or deny each.
  //   true           : refuse outright with a prescriptive reason.
  //                    Useful for batch work where you'd rather edit
  //                    Settings than dismiss modals.
  //
  // Ignored when protectedMode is false (no enforcement at all).
  autoDenyProtected: false,
  // Diagnostics toggle (Settings → Diagnostics → CLI debug logging).
  // When true, the CLI provider logs its full argv, the hook-settings
  // JSON contents, and on spawn failure a structured context object
  // to the Dev Tools console. Also sets `GRYPHON_HOOK_TRACE_FILE` so
  // hook scripts append per-invocation traces. All output is
  // console-only; never written to a user file or sent off-device.
  // Default off; opt-in for bug reports and cross-platform debugging.
  devCliDebug: false,
};

// Aliases — resolved to concrete versions by the local CLI at spawn.
// The CLI maps these to the latest models for each family, so no version
// numbers need to be hardcoded here. The resolved version is captured
// from the `system.init` stream event and shown in the model tooltip.
const MODELS = [
  { value: "haiku",     label: "Haiku",    desc: "Fast, cheapest" },
  { value: "sonnet",    label: "Sonnet",   desc: "Balanced" },
  { value: "opus",      label: "Opus",     desc: "Most capable" },
  { value: "opus[1m]",  label: "Opus 1M",  desc: "Most capable, 1M context" },
];

const EFFORTS = [
  { value: "low",    label: "Low",    desc: "Quick answers" },
  { value: "medium", label: "Medium", desc: "Standard" },
  { value: "high",   label: "High",   desc: "Thorough" },
];

const PERMS = [
  { value: "default",           label: "Prompt", desc: "Ask before every edit and command" },
  { value: "acceptEdits",       label: "Safe",   desc: "Auto-accept edits, still prompt on bash" },
  { value: "bypassPermissions", label: "YOLO",   desc: "Skip all checks" },
  { value: "plan",              label: "Plan",   desc: "Propose only" },
];

const MODEL_CONTEXT = {
  haiku: 200000, sonnet: 200000, opus: 200000,
  "opus[1m]": 1000000,
};

// Plugin-handled slash commands. Shared between the autocomplete dropdown
// and the help output so they stay in sync. Order is alphabetical so the
// dropdown is scannable regardless of typed prefix.
// takesArgs=true → autocomplete inserts a trailing space so the user can
// type arguments without a manual keystroke (e.g. /model <name>).
const SLASH_COMMANDS = [
  { cmd: "/clear",     desc: "Start a new session" },
  { cmd: "/compact",   desc: "Summarize the conversation and start fresh with the summary as context" },
  { cmd: "/context",   desc: "Show context window usage" },
  { cmd: "/cost",      desc: "Show session cost" },
  { cmd: "/effort",    desc: "Switch effort level (opens picker)", takesArgs: true },
  { cmd: "/export",    desc: "Save conversation as a note in Gryphon/Exports/", takesArgs: true },
  { cmd: "/help",      desc: "Show all commands and keyboard shortcuts" },
  { cmd: "/model",     desc: "Switch model (opens picker)", takesArgs: true },
  { cmd: "/perm",      desc: "Switch permission mode (opens picker)" },
  { cmd: "/quote",     desc: "Insert highlighted editor text as a quoted reference in your prompt" },
  { cmd: "/settings",  desc: "Open plugin settings" },
  { cmd: "/stop",      desc: "Stop the current turn" },
  { cmd: "/usage",     desc: "Show session usage (cost, tokens, messages, duration)" },
];

// Known CLI built-in slash commands that are blocked in stream-json
// mode (empirically verified). Forwarding these wastes a turn; we
// intercept them locally with a pointer to the CLI's own terminal.
// Anything NOT in this set and NOT in SLASH_COMMANDS is assumed to be a
// user-installed skill and forwarded to the CLI — skills like /review
// and /systematic-debugging fire real LLM turns in stream-json.
const CC_BLOCKED_IN_STREAM_JSON = new Set([
  "/resume", "/continue", "/status", "/agents",
  "/recap", "/mcp", "/hooks", "/plugin", "/plugins",
  "/doctor", "/login", "/logout", "/ide", "/memory", "/plan",
  "/config", "/version", "/voice", "/theme", "/exit",
  "/debug", "/chrome", "/stickers", "/feedback", "/advisor",
  "/add-dir", "/autocompact", "/focus", "/install",
  "/rename", "/session", "/skills", "/web-setup",
  "/btw", "/dream", "/fast", "/permissions", "/rate-limit-options",
]);
// Note: /model, /compact, /context, /cost, /usage are Gryphon commands
// (handled by the dispatch table), so they're intercepted before this
// blocklist applies. Listing them here would be redundant but harmless.

// Names that user-authored skills cannot claim. Derived from
// SLASH_COMMANDS (source of truth) with the leading "/" stripped —
// guarantees drift-free: adding a built-in automatically reserves its name.
const RESERVED_SKILL_NAMES = new Set(
  SLASH_COMMANDS.map((c) => c.cmd.replace(/^\//, ""))
);

const PROVIDER_PREFS = [
  { value: "anthropic-api", label: "Anthropic API (recommended)", desc: "Uses your Anthropic API key — the unambiguously terms-safe route" },
  { value: "claude-code",   label: "Claude Code (advanced)",      desc: "Spawns a local `claude` subprocess — confirm your usage complies with that product's terms" },
  { value: "auto",          label: "Auto",                        desc: "Prefer Claude Code if installed, else Anthropic API" },
];

// Human-readable title shown at the top of the protected-operation modal
// for each category key used by the default pattern lists above. Keep the
// key set in sync with the `category:` values in DEFAULT_PROTECTED_PATHS
// / DEFAULT_PROTECTED_COMMANDS. Unknown categories fall back to a generic
// title at render time (see attack-detector.js).
const PROTECTED_CATEGORIES = {
  "modifies-gryphon":       "⚠ Modifies Gryphon's own settings",
  "modifies-editor":       "⚠ Modifies Obsidian / editor settings",
  "runs-arbitrary-code":   "⚠ Runs code that could do anything",
  "escalates-privileges":  "⚠ Asks for administrator access",
  "accesses-system":       "⚠ Modifies system files or settings",
  "persistent-execution":  "⚠ Plants code that runs later",
  "destructive-operation": "⚠ Deletes files or data",
  "network-exec":          "⚠ Runs a command on another computer",
  "network-fetch":         "⚠ Downloads something from the internet",
  "user-custom":           "⚠ Matches a pattern you added",
};

module.exports = {
  TOOL_STATUS_CORE, DEFAULT_SETTINGS,
  DEFAULT_PROTECTED_PATHS, DEFAULT_PROTECTED_COMMANDS,
  PROTECTED_CATEGORIES,
  MODELS, EFFORTS, PERMS, MODEL_CONTEXT, SLASH_COMMANDS,
  CC_BLOCKED_IN_STREAM_JSON, RESERVED_SKILL_NAMES, PROVIDER_PREFS,
};
