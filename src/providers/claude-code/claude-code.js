/**
 * ClaudeCodeProvider — implements the LLMProvider contract via a
 * persistent `claude` CLI child process.
 *
 * Spawns claude with stream-json I/O and parses events (stream_event,
 * assistant, tool_use, result). Exposes message/tool/done callbacks per
 * the contract documented in ../provider-interface.js.
 *
 * Extension point: `options.extraArgs` is appended to the CLI args so
 * callers can supply plugin-specific flags without modifying this module.
 */

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { buildEnhancedPath, findNodeBinary } = require("../../utils");
const { buildDisallowedTools } = require("../shared/cc-disallow-translator");
const winSpawn = require("../shared/win-spawn");
const {
  buildHookSettings,
  buildPermissionsOnlySettings,
  writeHookSettingsFile,
  HOOK_FILES,
} = require("./hook-settings-builder");

// The system-prompt hints (anti-leak directives + fallback deny copy)
// were promoted to src/providers/shared/system-prompt-hints.js in
// v1.3 Stage 2.5 so Codex CLI (and future providers) reuse the same
// directives. See that file for the full rationale, the
// no-embedded-newlines constraint, and the history of the wording.
const {
  GRYPHON_SYSTEM_PROMPT_HINT,
  GRYPHON_FALLBACK_DENY_HINT,
} = require("../shared/system-prompt-hints");

// UUID shape match — 8-4-4-4-12 hex groups separated by dashes,
// case-insensitive. Intentionally LOOSER than strict RFC 4122 v4
// (which pins the 13th nibble to `4` and the 17th to [89ab]):
//   - CC currently emits v4 UUIDs, but a future CC version could
//     switch to v7 (time-ordered) without breaking our filter.
//   - CC does its own server-side validation — if we pass a
//     syntactically-valid-but-unknown UUID, CC errors with "no
//     conversation found" and our stale-session recovery kicks in.
//     The regex's job is to reject the obvious SDK-synthetic
//     `sdk-<timestamp>` form BEFORE it triggers that error.
//
// That "allow any shape, let CC decide" looseness is deliberate —
// tightening to strict v4 would regress the moment CC changes UUID
// flavor. If that flexibility becomes a liability, we can document
// the expected flavor and tighten here with a matching comment in
// the regex.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function _looksLikeUUID(value) {
  return typeof value === "string" && UUID_RE.test(value);
}

class ClaudeCodeProvider {
  constructor(claudePath, cwd, options = {}) {
    this.claudePath = claudePath;
    this.cwd = cwd;
    this.options = options;
    this.process = null;
    this.alive = false;
    this.sessionId = null;
    this.resolvedModel = null;
    this.buffer = "";
    this.lastCumulativeCost = 0;
    this.contextTokens = 0;

    this.turnText = "";
    // Issue #4: thinking blocks accumulated for the current turn. Each
    // turn produces zero or more thinking blocks; chat-view drains and
    // resets via the result emit at end-of-turn.
    this.turnThinking = [];
    // Per-block-index buffer used to assemble streamed thinking_delta
    // events into complete thinking blocks before they finalize. The
    // CC stream-json output groups deltas by content block index.
    this._thinkingByIndex = {};
    this.pendingResolve = null;
    this.pendingReject = null;

    // Rolling stderr buffer — only the tail survives so we can include it
    // in close-with-failure diagnostics without holding megabytes of
    // output alive. 4KB is enough for the usual CC stack trace / error
    // summary (typically 1-3 lines from CC's error path).
    this._stderrTail = "";

    this.onMessage = null;
    this.onError = null;
    this.onDone = null;
  }

  spawn() {
    if (this.alive) return;

    // v0.5.12: NO `-p` / `--print`. That flag makes CC exit after a
    // single result event; without it, CC stays alive in the stream-json
    // I/O loop, processes each stdin frame as a new prompt, and reuses
    // the same session_id across turns. This eliminates the per-send
    // "session not found" race entirely for steady-state use — CC holds
    // the conversation in memory for the life of the process.
    //
    // `--resume <id>` is still passed on the INITIAL spawn if we have a
    // stored session ID (plugin reload case). Subsequent turns within
    // one process never re-resume, so the stale-session risk is limited
    // to the first send per Obsidian session and is handled by the
    // stale-session recovery path below.
    const args = [
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
    ];

    // NOTE: The --append-system-prompt flag is pushed near the end of
    // this function, AFTER the hook-settings block runs, because the
    // fallback-deny directive is only added when we know for certain
    // that this spawn will NOT have hook-based enforcement. Hook
    // enablement depends on pre-flight checks that can fail at runtime;
    // composing the prompt after those checks lets us choose the right
    // guidance for the model based on the actual mode this spawn will
    // run in.

    if (this.options.model) args.push("--model", this.options.model);
    if (this.options.effort) args.push("--effort", this.options.effort);

    if (this.options.permissionMode && this.options.permissionMode !== "default") {
      args.push("--permission-mode", this.options.permissionMode);
    }

    // Claude Code accepts --resume <UUID | session-title>. Our SDK
    // provider sets synthetic IDs like `sdk-<timestamp>` because the
    // Anthropic API is stateless — these are not UUIDs and CC rejects
    // them outright with "Provided value '...' is not a UUID and does
    // not match any session title". When a user switches from SDK to
    // CLI, `lastSessionId` carries the SDK-shaped value forward and
    // (without this guard) reaches CC, triggering the error and the
    // stale-session recovery path, which shows the user a spurious
    // "previous CLI session wasn't found" notice.
    //
    // The right thing to do is silently drop any non-UUID here. CC
    // sessions live in per-project .jsonl files under ~/.claude/, and
    // only UUIDs index them. A synthetic SDK id could never match, so
    // passing it is strictly wrong. Dropping = fresh CLI session, no
    // user-visible churn.
    if (this.options.resumeSessionId && _looksLikeUUID(this.options.resumeSessionId)) {
      args.push("--resume", this.options.resumeSessionId);
    }

    // Protected Mode decides whether we instrument CC at all:
    //   protectedMode=false → no settings file, no hooks, no deny-list.
    //                      Protected patterns fall through to CC's
    //                      native permission-mode handling. "Real YOLO."
    //   protectedMode=true + autoDenyProtected=false → hooks (modal).
    //   protectedMode=true + autoDenyProtected=true  → hooks (auto-deny
    //                      without modal) + deny-list as fast-path /
    //                      fallback. Hooks MUST be on in auto-deny too —
    //                      the deny-list globs are byte-exact and miss
    //                      Unicode-obfuscated shapes (fullwidth `ｒｍ`,
    //                      zero-width-joined `r​m`). The hook's
    //                      classify() runs NFKC normalization which
    //                      catches those bypasses. See the auto-deny
    //                      short-circuit in _handleClassifyRequest that
    //                      preserves the "no modal for routine ops"
    //                      UX contract.
    //
    // Hooks additionally need a reachable IPC server, absolute plugin
    // dir, and a real node binary; if any of those fail pre-flight the
    // auto-deny settings file serves as the fallback (same enforcement,
    // no modal UI — better than silently unprotected).
    //
    // Resolve a real node binary up front. In Obsidian, `process.execPath`
    // is the Electron renderer and cannot execute a JS file — handing that
    // as a hook command silently fails.
    const plugin = this.options.plugin;
    const hookNodePath = findNodeBinary();
    const protectedModeOn =
      !!plugin && plugin.settings && plugin.settings.protectedMode !== false;
    const autoDenyProtected =
      !!plugin && plugin.settings && plugin.settings.autoDenyProtected === true;

    // Per-component visibility into enableHooks — the composite boolean
    // hides which specific check failed when hooks don't register, which
    // is exactly the diagnostic you need when debugging "hooks silently
    // didn't fire this spawn" issues (e.g. a Windows CLI auto-deny
    // bypass observed in practice, where a transient `ipcServer not
    // listening` state forced the deny-glob fallback and Unicode
    // normalization went dark without a user-visible signal).
    const hookPreflight = {
      protectedModeOn,
      hasIpcServer: !!(plugin && plugin.ipcServer),
      ipcServerListening: !!(plugin && plugin.ipcServer && plugin.ipcServer.isListening()),
      hasAbsolutePluginDir:
        !!(plugin && typeof plugin.absolutePluginDir === "function" && plugin.absolutePluginDir()),
      hasNodeBinary: !!hookNodePath,
    };
    const enableHooks =
      hookPreflight.protectedModeOn &&
      hookPreflight.hasIpcServer &&
      hookPreflight.ipcServerListening &&
      hookPreflight.hasAbsolutePluginDir &&
      hookPreflight.hasNodeBinary;

    // Try to register hooks first. Only after we know whether hooks are
    // actually wired do we decide whether to emit `--disallowedTools`.
    // Round-6 F1: doing this in the other order risks a silent
    // protection gap — if enableHooks is true but writeHookSettingsFile
    // throws (EROFS, ENOSPC), we'd ship with neither hooks nor deny-list.
    let hookSettingsFile = null;
    let hookSocketPath = null;
    if (enableHooks) {
      try {
        // Pre-flight: verify every hook script referenced in the
        // settings JSON actually exists on disk. If any is missing,
        // CC will silently fail to exec the hook at runtime (exit
        // code != 0 from the spawn, which CC treats as "allow" by
        // default), leaving the session unprotected without any
        // user-visible signal. This has happened once in the wild
        // (macOS: a `hooks` → `hooks 2` rename via iCloud sync
        // broke every hook; no modal, no trace log, no error). Fail
        // loudly at spawn time instead. Also covers the common
        // `ipc-client.js` library the hook scripts require.
        const hookDir = path.join(plugin.absolutePluginDir(), "hooks");
        const missing = [];
        for (const scriptName of Object.values(HOOK_FILES)) {
          const p = path.join(hookDir, scriptName);
          if (!fs.existsSync(p)) missing.push(p);
        }
        const ipcHelper = path.join(hookDir, "common", "ipc-client.js");
        if (!fs.existsSync(ipcHelper)) missing.push(ipcHelper);
        if (missing.length > 0) {
          // If the hooks/ directory itself is gone, scan the parent for
          // sibling directories whose names look like a cloud-sync
          // conflict rename. Each common sync service has its own
          // signature suffix; matching them in the error message lets
          // the user see the exact renamed folder instead of guessing.
          //
          //   iCloud:     "hooks 2", "hooks 3"
          //   OneDrive:   "hooks-Conflict", "hooks-<machine-name>"
          //   Dropbox:    "hooks (User.s conflicted copy 2026-04-22)"
          //   Syncthing:  "hooks.sync-conflict-20260422-..."
          //   Google Drive (file, not folder — safe to skip)
          let cloudHint = "";
          try {
            const pluginDir = plugin.absolutePluginDir();
            if (!fs.existsSync(hookDir) && fs.existsSync(pluginDir)) {
              const siblings = fs.readdirSync(pluginDir);
              const conflictRe = [
                /^hooks\s+\d+$/i,                    // iCloud: "hooks 2"
                /^hooks[-\s].*conflict/i,            // OneDrive / Dropbox
                /^hooks\.sync-conflict-/i,           // Syncthing
                /^hooks\s+\(.*\)$/i,                 // Dropbox "(conflicted copy ...)"
              ];
              const renamed = siblings.filter((name) =>
                name !== "hooks" && conflictRe.some((r) => r.test(name))
              );
              if (renamed.length > 0) {
                cloudHint =
                  `\n\nFound sibling folder(s) in the plugin directory ` +
                  `that look like a cloud-sync conflict rename:\n  ` +
                  `${renamed.join("\n  ")}\n\n` +
                  `If your vault is under iCloud, OneDrive, Dropbox, or ` +
                  `Syncthing, the sync service renamed your hooks folder ` +
                  `during a conflict. Rename the folder above back to ` +
                  `\`hooks\`. To prevent recurrence, move your vault to ` +
                  `a non-synced path — see the "Vault location and cloud ` +
                  `sync" section in Gryphon/MANUAL.md.`;
              }
            }
          } catch (_) { /* readdir failed — skip hint, keep base message */ }
          throw new Error(
            `Gryphon plugin helper files not found — the plugin directory ` +
            `is incomplete or mis-linked. Missing:\n  ${missing.join("\n  ")}` +
            `${cloudHint}\n\n` +
            `Running with basic protection only until this is fixed.`,
          );
        }

        hookSocketPath = plugin.ipcServer.socketPath();
        const settings = buildHookSettings({
          pluginDir: plugin.absolutePluginDir(),
          socketPath: hookSocketPath,
          nodePath: hookNodePath,
        });
        hookSettingsFile = writeHookSettingsFile(settings);
        args.push("--settings", hookSettingsFile);
      } catch (e) {
        const msg = (e && e.message) || String(e);
        console.error("[gryphon/cli] hook settings build failed; falling back to --disallowedTools:", msg);
        // Surface to the user via an Obsidian Notice so this class of
        // failure isn't just-a-console-line. Required for bug-report
        // actionability — prior to this, "Claude Code mode provides no
        // protection" presented as "no modal ever" with no indication
        // where to look.
        try {
          const { Notice } = require("obsidian");
          new Notice(
            `Gryphon: advanced protections unavailable — plugin files are incomplete.\n\n${msg}`,
            20000,  // 20s — long enough to read the path
          );
        } catch (_) { /* obsidian not available (tests / headless) */ }
        if (hookSettingsFile && fs.existsSync(hookSettingsFile)) {
          try { fs.unlinkSync(hookSettingsFile); } catch (_) { /* ignore */ }
        }
        hookSettingsFile = null;
        hookSocketPath = null;
      }
    }

    // v0.5.6 → v0.9.x: Translate the user's active Gryphon
    // protected-patterns into CC's native deny-list. When hooks are ON,
    // the PreToolUse hook is the sole enforcement point — any deny-list
    // would short-circuit the approval modal (CC applies permissions.deny
    // *before* firing hooks), so we suppress it. When hooks are OFF,
    // or when hook registration failed above, we fall back to a
    // permissions-only settings file so Claude Code mode is never left
    // unprotected (Round-6 F1).
    //
    // v0.9.1: the previous implementation emitted one
    // `--disallowedTools <glob>` per rule on argv. With ~180 rules on
    // Windows that pushed past cmd.exe's 8191-char hard limit ("The
    // command line is too long" from the shim). Moving the list into
    // the settings JSON drops argv length to near-zero regardless of
    // rule count — CC reads permissions.deny from disk with no length
    // ceiling.
    const hooksActive = !!hookSettingsFile;
    // Deny-list fallback is ONLY for Protected Mode ON. If it's off,
    // the user has opted out of pattern-based enforcement entirely;
    // writing a deny-list would contradict that choice.
    //
    // The first Notice (for Auto-deny + !hooksActive) used to fire
    // BEFORE this block, unconditionally promising "basic enforcement".
    // That lied when denyGlobs ended up empty (user disabled all
    // defaults, or custom regexes produced no mappable globs). Compute
    // denyGlobs FIRST, then decide what the Notice should say.
    let denyGlobs = [];
    if (!hooksActive && protectedModeOn) {
      denyGlobs = plugin && plugin.settings
        ? buildDisallowedTools(plugin.settings)
        : [];
    }
    if (autoDenyProtected && protectedModeOn && !hooksActive) {
      try {
        const { Notice } = require("obsidian");
        const failed = Object.entries(hookPreflight)
          .filter(([, v]) => !v)
          .map(([k]) => k)
          .join(", ");
        const reason = failed.length > 0
          ? `preflight failed on ${failed}`
          : "hook settings-file write failed (see Dev Tools console)";
        const notice = denyGlobs.length > 0
          ? (
              `Gryphon: Auto-deny falling back to basic pattern enforcement — ` +
              `normalized-input protection (fullwidth / zero-width Unicode) ` +
              `is not active this session. Reason: ${reason}. ` +
              `Reload Obsidian (Cmd/Ctrl+P → "Reload app without saving") to restore.`
            )
          : (
              `Gryphon: NO PATTERN ENFORCEMENT this CLI session — ` +
              `hook setup failed (${reason}) AND the deny-list fallback ` +
              `produced zero globs (check your protected-pattern list). ` +
              `Reload Obsidian to restore.`
            );
        new Notice(notice, 15000);
      } catch (_) { /* obsidian not available in tests / headless */ }
    }
    if (!hooksActive && protectedModeOn) {
      if (denyGlobs.length > 0) {
        try {
          const permSettings = buildPermissionsOnlySettings(denyGlobs);
          hookSettingsFile = writeHookSettingsFile(permSettings);
          args.push("--settings", hookSettingsFile);
        } catch (e) {
          // If we can't write the deny-list file (EROFS, ENOSPC,
          // symlink-race with wx flag, etc.) the spawn still proceeds
          // — but with no Gryphon-enforced protection in Claude Code mode. Log
          // to Dev Tools so a user who reports "no approval modal
          // appeared" has a trail.
          const msg = (e && e.message) || String(e);
          console.error("[gryphon/cli] fallback permissions file write failed:", msg);
          // In Auto-deny mode, a fallback-write failure here leaves the
          // session completely unprotected in CLI (no hooks, no deny-
          // globs). The Notice a few lines above announced "falling
          // back to basic enforcement" — but if THIS write also fails,
          // the "basic" isn't there either. Show a second, more
          // severe Notice making that explicit. (Hook-mode users who
          // fall back here already saw the upstream "plugin files
          // incomplete" Notice, so we skip to avoid redundant toasts.)
          if (autoDenyProtected) {
            try {
              const { Notice } = require("obsidian");
              new Notice(
                `Gryphon: couldn't apply protected-pattern enforcement — ` +
                `Auto-deny settings file write failed (${msg}). The CLI ` +
                `will run without pattern enforcement this session. ` +
                `Check available space / permissions on the system ` +
                `temp directory, then restart Gryphon.`,
                20000,
              );
            } catch (_) { /* obsidian not available in tests / headless */ }
          }
        }
      }
    }
    // Track for cleanup in _handleClose so we don't litter tmpdir.
    // Applies to both hook-mode and fallback-mode settings files.
    this._hookSettingsFile = hookSettingsFile;

    // Compose --append-system-prompt. Deferred to here (rather than
    // earlier with the rest of args) because the fallback-mode hint
    // is only added when we know for certain this spawn will run in
    // deny-list mode — `hooksActive` is only reliable after the hook
    // pre-flight + settings-file write has either succeeded or thrown.
    //
    // Separator is " · " (not "\n\n") because on Windows we spawn via
    // `shell: true` which funnels the whole argv through cmd.exe, and
    // cmd.exe doesn't preserve newlines inside quoted args — a "\n\n"
    // join would silently truncate every subsequent flag (including
    // `--settings`, which is how hooks get registered). The bullet
    // char is model-legible and keeps the chunks visually distinct.
    const appendParts = [GRYPHON_SYSTEM_PROMPT_HINT];
    if (!hooksActive && protectedModeOn) {
      // Protected Mode ON + no hooks = auto-deny fallback path. CC returns
      // its own terse refusal to the model rather than our prescriptive
      // "open Settings → uncheck …" text, so we inject guidance telling
      // the model exactly what to say. Not added when Protected Mode
      // is OFF — there's no refusal to explain in that mode.
      appendParts.push(GRYPHON_FALLBACK_DENY_HINT);
    }
    if (typeof this.options.compactionSummary === "string" && this.options.compactionSummary.length > 0) {
      // Also flatten newlines inside the compaction summary itself.
      appendParts.push(this.options.compactionSummary.replace(/\s*\n\s*/g, " "));
    }
    args.push("--append-system-prompt", appendParts.join(" · "));

    // Plugin-specific args appended last — callers supply whatever they need.
    // Issue #39: drop flags that belong to other providers (codex/gemini)
    // so a multi-provider consumer can pass a shared extraArgs without
    // breaking spawns on the other CLIs.
    if (this.options.extraArgs && Array.isArray(this.options.extraArgs)) {
      const { filterExtraArgs } = require("../shared/extra-args-filter");
      const { filtered, dropped } = filterExtraArgs(this.options.extraArgs, "claude-code");
      if (dropped.length > 0) {
        // Round 4 review (SFH-1): use console.error not warn — DevTools
        // hides "warn" by default but shows "error", and consumers
        // routinely never open DevTools at all. error is louder; if a
        // consumer's allowedTools restriction is being silently no-op'd,
        // they should see it as soon as they open the panel.
        console.error(
          `[gryphon/claude-code] Dropped ${dropped.length} cross-provider flag(s) ` +
          `from extraArgs: ${dropped.join(", ")}. Use options.extraProcessArgsByProvider ` +
          `for clean per-provider targeting.`,
        );
      }
      args.push(...filtered);
    }

    // Emit the full CC arg vector, hook-settings file path + contents,
    // and env-var wiring to `console.error` when the `devCliDebug`
    // toggle is on (Settings → Gryphon → Diagnostics → CLI debug
    // logging). Default off. GRYPHON_CLI_DEBUG env var is also
    // honored for headless / CI diagnostics where flipping a
    // settings toggle isn't practical.
    const debugCli = !!process.env.GRYPHON_CLI_DEBUG ||
      !!(plugin && plugin.settings && plugin.settings.devCliDebug);
    if (debugCli) {
      console.error("[gryphon/cli] spawn:", this.claudePath, args.join(" "));
      if (hookSettingsFile) {
        console.error("[gryphon/cli] hook settings:", hookSettingsFile);
        console.error("[gryphon/cli] GRYPHON_PERMISSION_SOCKET:", hookSocketPath);
        console.error("[gryphon/cli] hook node binary:", hookNodePath);
        // Dump the settings JSON contents inline. Without this, a
        // failure mode where CC silently rejects the file (bad shape,
        // unknown field, unreadable path) shows up only as "hooks
        // don't fire" — indistinguishable from a runtime failure
        // inside the hook script. Seeing the exact bytes we handed
        // CC lets us rule out the entire config path in one glance.
        try {
          const contents = fs.readFileSync(hookSettingsFile, "utf8");
          console.error("[gryphon/cli] hook settings contents:\n" + contents);
        } catch (e) {
          console.error("[gryphon/cli] hook settings read-back failed:", e && e.message);
        }
      } else if (plugin && plugin.settings && plugin.settings.protectedMode !== false) {
        console.error("[gryphon/cli] hooks disabled — findNodeBinary:", hookNodePath, "pluginDir:", typeof plugin.absolutePluginDir === "function" ? plugin.absolutePluginDir() : null);
      }
      // Always dump the per-component preflight so a "hooks silently
      // not firing" report is diagnosable from the log alone. Cheap —
      // a single line per spawn when debug logging is on.
      console.error("[gryphon/cli] hook preflight:", JSON.stringify(hookPreflight));
    }

    const spawnEnv = { ...process.env, PATH: buildEnhancedPath() };
    if (hookSocketPath) {
      spawnEnv.GRYPHON_PERMISSION_SOCKET = hookSocketPath;
    }
    // When CLI debug logging is on, ask hook scripts to append a
    // JSON trace line per invocation to a known file. Lets users
    // confirm hooks are actually firing and attach the raw CC-input
    // fingerprint to bug reports. Log grows only while debug is on.
    if (debugCli) {
      const traceFile = path.join(os.tmpdir(), "gryphon-hook-trace.log");
      spawnEnv.GRYPHON_HOOK_TRACE_FILE = traceFile;
      console.error("[gryphon/cli] GRYPHON_HOOK_TRACE_FILE:", traceFile);
    }

    // Windows .cmd / .bat spawn. Node.js refuses to spawn shim files
    // directly since CVE-2024-27980 (returns EINVAL), so we need to
    // route through cmd.exe. The original `shell:true` approach
    // worked for short arg sets but fails when an arg contains literal
    // `"` characters: cmd.exe's parser has no `\"` escape, the
    // embedded quote terminates the wrapper quote prematurely, and the
    // remainder of the arg gets re-tokenized as separate cmd.exe
    // tokens — which in our case (--append-system-prompt with text
    // like `no "The Gryphon plugin is blocking this"`) trips ENOENT
    // ("The system cannot find the file specified") on a stray
    // path-shaped token. User report 2026-05-04, Windows VM.
    //
    // The fix is the same wrapForCmdShim helper Codex / Gemini use:
    // build the cmd.exe /d /s /c command line ourselves with proper
    // CommandLineToArgvW quoting + cmd.exe metachar escaping +
    // newline collapse, then set windowsVerbatimArguments so Node
    // doesn't re-escape what we've already escaped. Stdin/stdout
    // pipes remain attached because cmd.exe inherits them; the
    // stream-json protocol still works.
    const spawnOpts = {
      cwd: this.cwd,
      env: spawnEnv,
      stdio: ["pipe", "pipe", "pipe"],
    };
    let spawnCommand = this.claudePath;
    let spawnArgs = args;
    if (winSpawn.isWindowsShim(this.claudePath)) {
      const wrapped = winSpawn.wrapForCmdShim(this.claudePath, args);
      spawnCommand = wrapped.command;
      spawnArgs = wrapped.args;
      Object.assign(spawnOpts, wrapped.options);
    }
    // Snapshot just enough spawn context for _handleProcessError to
    // report if the OS rejects the launch (EINVAL, ENOENT, EACCES).
    // Kept small on purpose — args can contain a long system prompt and
    // we don't want to dump the whole thing into user-facing logs.
    this._lastSpawnDiagnostic = {
      windowsWrapped: spawnCommand !== this.claudePath,
      argCount: args.length,
      firstFive: args.slice(0, 5),
      lastFive: args.slice(-5),
      resumeSessionId: this.options.resumeSessionId || null,
      hookSettingsFile: hookSettingsFile,
    };
    const proc = spawn(spawnCommand, spawnArgs, spawnOpts);
    this.process = proc;
    this.alive = true;
    this.buffer = "";
    this.lastCumulativeCost = 0;

    // Guard every event handler against firing for a process that's
    // no longer current. During stale-session recovery we kill the
    // old CC and spawn a new one; the old process's stderr/close
    // events can still fire AFTER the new one is running, so we
    // bind a closed-over `proc` reference and only dispatch if it
    // still matches this.process.
    const forThisProcess = () => this.process === proc;
    proc.stdout.on("data", (data) => { if (forThisProcess()) this._handleStdout(data); });
    proc.stderr.on("data", (data) => { if (forThisProcess()) this._handleStderr(data); });
    proc.on("close", (code) => { if (forThisProcess()) this._handleClose(code); });
    proc.on("error", (err) => { if (forThisProcess()) this._handleProcessError(err); });
  }

  send(prompt) {
    if (!this.alive || !this.process) this.spawn();

    // v0.5.12 supersede handling. Without `-p`, CC stays alive across
    // turns — which means an in-flight turn's result could arrive and
    // be matched to a NEWER pendingResolve that the supersede installed,
    // so the user's new prompt would appear to be answered by the old
    // one. Tracking turn IDs is brittle (CC doesn't echo our prompt
    // id); safer to kill+respawn CC when the user supersedes. The
    // common wait-then-send path is unaffected because pendingReject
    // is null by the time the next send() runs.
    if (this.pendingReject) {
      const reject = this.pendingReject;
      this.pendingResolve = null;
      this.pendingReject = null;
      if (this.process) {
        try { this.process.kill("SIGTERM"); } catch {}
        this.process = null;
      }
      this.alive = false;
      this.spawn();
      reject(new Error("Superseded by new message"));
    }

    // Remember the prompt so we can re-send transparently if we hit
    // the "stale session" recovery path below.
    this._lastPrompt = prompt;

    return new Promise((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;
      this.turnText = "";

      this._writePrompt(prompt, reject);
    });
  }

  _writePrompt(prompt, onWriteError) {
    const msg = JSON.stringify({
      type: "user",
      message: { role: "user", content: prompt },
    });
    try {
      this.process.stdin.write(msg + "\n");
    } catch (err) {
      if (onWriteError) onWriteError(err);
    }
  }

  /**
   * CC prints "No conversation found with session ID: <uuid>" to stderr
   * when `--resume` points at a session that's no longer in its local
   * store (jsonl rotated, CC upgraded, user ran `claude --clear-history`,
   * etc.). The process then exits and Gryphon hangs waiting for a result.
   *
   * Recovery: notify the host to clear its stored lastSessionId, kill the
   * dead CC, respawn WITHOUT --resume, re-send the prompt. The user sees
   * a brief pause plus a system message explaining what happened, then
   * their answer streams in normally.
   *
   * The recovery fires at most once per provider instance (`_staleRecoveryFired`),
   * so if the fresh spawn somehow also fails, we surface that error to the
   * user rather than looping.
   */
  _handleStaleSession() {
    if (this._staleRecoveryFired) return;
    this._staleRecoveryFired = true;

    const prompt = this._lastPrompt;

    // Tear down the failed process.
    if (this.process) {
      try { this.process.kill("SIGTERM"); } catch {}
      this.process = null;
    }
    this.alive = false;

    // Drop the stale resume so spawn() doesn't pass --resume again.
    this.options.resumeSessionId = undefined;
    this.sessionId = null;

    // Ask the host (chat-view) to wipe its persisted lastSessionId too.
    // Without this, the NEXT provider constructed by the factory would
    // re-read the stale ID from settings and fail the same way.
    if (typeof this.onSessionExpired === "function") {
      try { this.onSessionExpired(); } catch {}
    }

    // Respawn and re-send the pending prompt.
    this.spawn();
    if (prompt) {
      this._writePrompt(prompt, (err) => {
        if (this.pendingReject) this.pendingReject(err);
      });
    }
  }

  _handleStdout(data) {
    this.buffer += data.toString();
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        this._processEvent(parsed);
      } catch (e) {
        if (!(e instanceof SyntaxError)) {
          console.error("ClaudeCodeProvider: error processing event:", e);
        }
      }
    }
  }

  _processEvent(raw) {
    if (raw.type === "system") {
      if (raw.subtype === "init") {
        this.sessionId = raw.session_id;
        // Capture the concrete model ID (e.g. "claude-opus-4-7") that the
        // CLI resolved our alias ("opus") to. Lets the UI show the real
        // version without hardcoding anything.
        if (raw.model) this.resolvedModel = raw.model;
        if (this.onMessage) this.onMessage("", "init");
      }
      return;
    }

    if (raw.type === "stream_event") {
      const event = raw.event || {};
      // Block-start padding: when a NEW text content block begins
      // and turnText already has content from a prior block (typical
      // shape: model emitted text → called a tool → emits a new text
      // block with the deny copy), insert a paragraph break so the
      // two blocks don't visually run together. Without this, the
      // text-delta handler below pure-concatenates, producing
      // "...deletion now.This operation matches..." with no space.
      // User report 2026-05-04. Idempotent: skips if turnText is
      // empty or already ends in `\n\n`.
      if (event.type === "content_block_start" &&
          event.content_block?.type === "text" &&
          this.turnText &&
          !this.turnText.endsWith("\n\n")) {
        this.turnText += this.turnText.endsWith("\n") ? "\n" : "\n\n";
      }
      if (event.type === "content_block_delta" &&
          event.delta?.type === "text_delta" && event.delta.text) {
        this.turnText += event.delta.text;
        if (this.onMessage) this.onMessage(this.turnText, "replace");
      } else if (event.type === "content_block_delta" &&
                 event.delta?.type === "thinking_delta" &&
                 typeof event.delta.thinking === "string") {
        // Issue #4: assemble streamed thinking_delta events. Each delta
        // carries a chunk plus the index of the content block it
        // belongs to; we buffer per-index so concurrent thinking blocks
        // (rare but possible) don't merge.
        const idx = typeof event.index === "number" ? event.index : 0;
        this._thinkingByIndex[idx] = (this._thinkingByIndex[idx] || "") + event.delta.thinking;
      }
      return;
    }

    if (raw.type === "assistant" && raw.message?.content) {
      for (const block of raw.message.content) {
        if (block.type === "text" && block.text) {
          // Append-or-set semantics: stream_event content_block_delta
          // events accumulate streamed deltas into turnText. The
          // `assistant` event delivers the FINAL form of each assistant
          // message — for compound prompts ("summarize then delete"
          // where the delete is denied), CC produces TWO assistant
          // messages: the first carries the summary (which streamed
          // through deltas), and the second carries the deny copy
          // WITHOUT streaming (it's emitted as a single complete
          // assistant event with content[].text — there are no
          // intervening deltas because the model didn't generate it
          // token-by-token; it arrived from the tool-error path).
          //
          // Old code: `if (!this.turnText) this.turnText = block.text` —
          // skipped the deny block because turnText already held the
          // summary. User saw the summary but the deny disappeared.
          //
          // New code: if turnText is empty OR doesn't already contain
          // this block's text, append (with a paragraph break for
          // readability when there's prior content). The
          // already-contains check avoids double-rendering when the
          // deltas already streamed the block.
          // User report 2026-05-03.
          if (!this.turnText) {
            this.turnText = block.text;
          } else if (!this.turnText.includes(block.text)) {
            this.turnText = this.turnText + "\n\n" + block.text;
          }
          if (this.onMessage) this.onMessage(this.turnText, "replace");
        }
        if (block.type === "tool_use") {
          if (this.onMessage) this.onMessage(block.name, "tool");
        }
        // Issue #4: capture full thinking blocks. Some CC versions emit
        // the complete block in the assistant event rather than via
        // streamed deltas; handle both shapes.
        if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.length > 0) {
          this.turnThinking.push(block.thinking);
        } else if (block.type === "redacted_thinking") {
          this.turnThinking.push("[redacted thinking]");
        }
      }
      // Track context from the LAST assistant message's usage (per-API-call, not cumulative).
      // Only input tokens count against the context window — not output tokens.
      if (raw.message?.usage) {
        const u = raw.message.usage;
        this.contextTokens =
          (u.input_tokens || 0) +
          (u.cache_creation_input_tokens || 0) +
          (u.cache_read_input_tokens || 0);
      }
      return;
    }

    if (raw.type === "tool_use") {
      if (this.onMessage) this.onMessage(raw.name || "unknown", "tool");
      return;
    }

    if (raw.type === "tool_result") { return; }

    if (raw.type === "result") {
      const cumulativeCost = raw.total_cost_usd || 0;
      const turnCost = cumulativeCost - this.lastCumulativeCost;
      this.lastCumulativeCost = cumulativeCost;

      // Don't overwrite contextTokens from result — it's cumulative across
      // all API calls in the turn. The assistant message usage is per-call.

      // Issue #4: flush any streamed thinking_delta buffers into the
      // turn-thinking list so the result carries every block.
      const indexedThinking = Object.keys(this._thinkingByIndex)
        .sort((a, b) => Number(a) - Number(b))
        .map((k) => this._thinkingByIndex[k])
        .filter((s) => typeof s === "string" && s.length > 0);
      const turnThinking = [...this.turnThinking, ...indexedThinking];

      // Prefer the streaming-accumulated turnText over CC's `raw.result`.
      // For compound prompts ("summarize then delete X" where one
      // sub-request hits a protected pattern), the agent loop produces
      // TWO assistant chunks: the safe answer (summary) BEFORE the tool
      // call, and the deny text AFTER. CC's `raw.result` field carries
      // only the LAST assistant chunk's text (the deny), while turnText
      // accumulates BOTH chunks via stream_event content_block_delta.
      // Using raw.result drops the safe sub-answer the user already
      // saw streaming in — it appears, then disappears at turn end
      // when onDone overrides the bubble. Using turnText preserves the
      // full transcript. raw.result is a defensive fallback for the
      // edge case where streaming produced no text at all.
      // User report 2026-05-03.
      const text = this.turnText || raw.result || "";
      const result = {
        text,
        cost: turnCost,
        cumulativeCost,
        sessionId: raw.session_id || this.sessionId,
        duration: raw.duration_ms,
        contextTokens: this.contextTokens,
        thinking: turnThinking.length > 0 ? turnThinking : undefined,
      };

      if (this.onDone) this.onDone(result);
      if (this.pendingResolve) {
        this.pendingResolve(result);
        this.pendingResolve = null;
        this.pendingReject = null;
      }
      this.turnText = "";
      this.turnThinking = [];
      this._thinkingByIndex = {};
    }
  }

  _handleStderr(data) {
    const raw = data.toString();
    // Keep a rolling tail so _handleClose has something to surface if CC
    // dies before emitting a result event. Append first, trim to the
    // last 4KB — cheap enough on every stderr chunk.
    if (raw) {
      this._stderrTail = (this._stderrTail + raw).slice(-4096);
    }
    const text = raw.trim();
    if (!text) return;
    // Stale-session detection: CC writes this exact sentence to stderr
    // when --resume points at a missing session. Intercept before
    // surfacing to the user — we can recover transparently.
    if (/No conversation found with session ID/i.test(text)) {
      this._handleStaleSession();
      return;
    }
    if (this.onError) this.onError(text);
  }

  _handleClose(code) {
    this.alive = false;
    this.process = null;
    this._cleanupHookSettingsFile();
    if (this.pendingReject) {
      this.pendingReject(new Error(this._formatCloseError(code)));
      this.pendingResolve = null;
      this.pendingReject = null;
    }
    // Reset the tail for the next spawn so stale stderr from a prior
    // process can't leak into a future close message.
    this._stderrTail = "";
  }

  /**
   * Build a user-facing error message for an unexpected CLI exit.
   *
   * CC typically exits 0 with a result event on normal completion. An
   * exit BEFORE a result event means one of:
   *   - An invalid arg (flag parse error, unknown model, bad --settings)
   *   - A runtime crash (uncaught exception, permission problem)
   *   - A hook/IPC chain that ate the turn (rare, but has happened)
   *   - Something matched `--disallowedTools` and CC didn't recover
   *
   * None of these are debuggable from "exit code 1" alone. Including
   * the stderr tail turns the ticket from "unactionable" into "here's
   * the exact error the CLI printed" — the user can match it against
   * their settings or paste it into a bug report.
   */
  _formatCloseError(code) {
    const stderr = (this._stderrTail || "").trim();
    const header = code === 0
      ? "Claude Code ended without producing a response."
      : `Claude Code exited unexpectedly (exit code ${code}).`;

    const parts = [header];

    if (stderr) {
      // Last 6 non-empty lines — CC's informative errors are typically
      // 1-3 lines; 6 covers stack-trace-adjacent context without
      // dumping multi-KB spew into the chat view.
      const tail = stderr
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(-6)
        .join("\n");
      // Redact paths / keys from the surfaced error so a user sharing
      // a bug report (screenshot, copy-paste) doesn't inadvertently
      // leak their home directory layout, vault location, or any
      // API-key fragment that CC might have echoed in a debug line.
      // The redactions are best-effort — this isn't a security
      // boundary, but it's cheap insurance against the common
      // screenshot-into-GitHub-issue flow.
      const redacted = this._redactStderrForDisplay(tail);
      parts.push(`\n\nDetails from Claude Code:\n${redacted}`);
    }

    parts.push(
      "\n\nCommon causes: a tool call matched a rule and couldn't " +
      "recover, a path was outside the vault, or the CLI hit an " +
      "internal error. Try asking again. For more detail, turn on " +
      "Settings → Gryphon → Diagnostics → CLI debug logging and " +
      "repeat — the Developer Tools console will have the full " +
      "invocation context."
    );

    return parts.join("");
  }

  /**
   * Replace paths / API-key fragments / vault root in stderr text
   * before it's surfaced to the user in an error message. Targets
   * the common bug-report flow where users screenshot the chat
   * panel; the error line shouldn't expose their username, home
   * directory, or any provider-key fragment that CC may have echoed.
   */
  _redactStderrForDisplay(text) {
    if (typeof text !== "string" || !text) return text;
    let out = text;
    const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Replace home directory (safely — falls back to no-op if
    // os.homedir() isn't resolvable in the test harness).
    try {
      const home = os.homedir();
      if (home && home.length >= 3) {
        out = out.replace(new RegExp(escapeRe(home), "g"), "~");
      }
    } catch (_) { /* os.homedir unavailable; skip */ }
    // Replace the vault root path too — users who keep their vault
    // in a non-home location (e.g., /mnt/vault/, D:\Vault\) would
    // still leak that path via echoed CC error lines. cwd is the
    // vault root per claude-code spawn contract.
    if (this.cwd && typeof this.cwd === "string" && this.cwd.length >= 3) {
      try {
        out = out.replace(new RegExp(escapeRe(this.cwd), "g"), "<vault>");
      } catch (_) { /* bad path; skip */ }
    }
    // Redact any sk-ant-* fragment that CC ever echoes in debug
    // output (low risk today; defense-in-depth for future CC builds).
    out = out.replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, "sk-ant-***REDACTED***");
    return out;
  }

  _handleProcessError(err) {
    this.alive = false;
    this._cleanupHookSettingsFile();
    // Log the full spawn context on any proc error. EINVAL in particular
    // is uninformative on its own (it just means the OS refused the exec
    // call) — without the claudePath, shell flag, platform, and arg
    // fingerprint alongside it, a user report of "spawn EINVAL" is
    // unactionable. This is the diagnostic that turns the next
    // repro-in-the-wild into a fixable ticket.
    try {
      const args = this._lastSpawnDiagnostic || {};
      console.error(
        "[gryphon/cli] process error:",
        {
          code: err && err.code,
          errno: err && err.errno,
          syscall: err && err.syscall,
          message: err && err.message,
        },
        "context:",
        {
          claudePath: this.claudePath,
          platform: process.platform,
          windowsWrapped: args.windowsWrapped,
          argCount: args.argCount,
          firstFiveArgs: args.firstFive,
          lastFiveArgs: args.lastFive,
          resumeSessionId: args.resumeSessionId,
          hookSettingsFile: args.hookSettingsFile,
        },
      );
    } catch (_) { /* logging must never throw */ }
    if (this.pendingReject) {
      this.pendingReject(err);
      this.pendingResolve = null;
      this.pendingReject = null;
    }
  }

  /**
   * Remove the per-spawn hook settings file. Best-effort: a leftover
   * file in tmpdir is not a security or correctness issue (the file
   * doesn't auto-load anywhere — CC only sees it when we pass
   * --settings explicitly), so a failed unlink is logged and swallowed.
   */
  _cleanupHookSettingsFile() {
    if (!this._hookSettingsFile) return;
    const file = this._hookSettingsFile;
    this._hookSettingsFile = null;
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch (e) {
      console.warn(`[gryphon/cli] failed to remove hook settings file ${file}: ${e.message}`);
    }
  }

  abort() {
    if (this.process) {
      try { this.process.stdin.end(); } catch {}
      this.process.kill("SIGTERM");
      const proc = this.process;
      setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 5000);
      this.process = null;
    }
    this.alive = false;
    // Clean up the per-spawn settings file directly here. The async
    // `close` event that fires when CC dies is guarded by
    // `forThisProcess()` which returns false once we null out
    // `this.process` above — so _handleClose won't fire, and without
    // this explicit cleanup the settings file would leak on every
    // plugin disable/re-enable cycle (observed during Stage-8 QA as
    // growing accumulation in $TMPDIR).
    this._cleanupHookSettingsFile();
    if (this.pendingReject) {
      this.pendingReject(new Error("Aborted"));
      this.pendingResolve = null;
      this.pendingReject = null;
    }
  }

  isAlive() { return this.alive && this.process !== null; }

  // Claude Code mode: cost comes from Claude Code's `total_cost_usd` field, which
  // Anthropic computes server-side. Authoritative.
  get costIsEstimate() { return false; }
}

module.exports = { ClaudeCodeProvider };
