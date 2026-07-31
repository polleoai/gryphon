// TypeScript module marker.

/**
 * Antigravity CLI (`agy`) hook adapter.
 *
 * Antigravity has a real lifecycle-hook system with Claude-Code-compatible
 * event names (`PreToolUse` / `PostToolUse`), a JSON-over-stdin/stdout
 * contract, and — critically — a `deny` decision that HARD-BLOCKS the tool
 * even when the process was spawned with `--dangerously-skip-permissions`.
 * That last property is what makes real enforcement possible here, and it
 * was verified live against `agy` v1.1.8 rather than taken from docs.
 *
 * ── Why this adapter writes to a file the user owns ──────────────────────
 *
 * Every other adapter writes its hook config to a private temp file and
 * points the CLI at it via an env var, so a crashed Gryphon can never leave
 * config behind that affects the user's own interactive CLI use.
 *
 * Antigravity offers no such redirect. Verified against v1.1.8:
 *
 *   - `.agents/hooks.json` in the spawn cwd is NOT read by the CLI —
 *     `hooks_manager: loaded 0 named hooks from 0 hooks.json file(s)`,
 *     with and without a VCS root above it.
 *   - The only location honoured is the global customization root,
 *     `~/.gemini/config/hooks.json`:
 *     `Loaded hooks.json from /Users/…/.gemini/config/hooks.json`.
 *   - No `AGY_*` / `ANTIGRAVITY_*` environment variable redirects it.
 *
 * So this adapter MERGES a single named key into a file the user may also
 * be using, which imposes three rules it must never break:
 *
 *   1. Never clobber. Read → merge our one key → write back. Other named
 *      hooks (theirs, or another tool's) survive untouched. Antigravity
 *      merges same-event handlers across names, so coexistence is fine.
 *   2. Never delete their file. `uninstall` removes ONLY our key; the file
 *      is removed only when our key was the sole content, so we don't
 *      leave `{}` litter in their config either.
 *   3. Self-heal. A crash between install and cleanup would leave our key
 *      pointing at a pretool script that denies when it can't reach the
 *      plugin — silently gating the user's own `agy` sessions. `stripStale`
 *      runs on plugin load and before each install to clear that.
 *
 * A file we cannot parse is left exactly as found: silently overwriting a
 * user's config to fix our own merge is worse than degrading hooks.
 */

const path = require("path") as typeof import("path");
const fs = require("fs") as typeof import("fs");
const os = require("os") as typeof import("os");
const crypto = require("crypto") as typeof import("crypto");
const {
  DEFAULT_HOOK_TIMEOUTS,
  HOOK_FILES,
} = require("../../../provider-runtime/src/providers/claude-code/hook-settings-builder");

const KIND = "antigravity-cli";

/**
 * Top-level key we own inside the shared hooks.json. Antigravity keys hook
 * specs by name and merges across names, so this is our whole footprint.
 */
const HOOK_KEY = "gryphon";

/**
 * The one location `agy` reads hooks from (see header). Not configurable.
 */
function hooksFilePath(): string {
  return path.join(os.homedir(), ".gemini", "config", "hooks.json");
}

/**
 * Build one handler command, with Gryphon's hook environment baked into the
 * command string rather than inherited from the spawn.
 *
 * Why not rely on the spawn env like the other adapters do: if
 * GRYPHON_HOOK_DIALECT fails to reach the hook process, pretool.js emits
 * Claude-shaped output, Antigravity cannot parse a decision from it, and it
 * runs the tool. Verified live — the guardrail degrades to silent-allow,
 * with no error anywhere. Every other failure in this file is loud; this one
 * was not, so the dependency is removed instead of documented.
 *
 * Antigravity runs handlers through `sh -c` on Unix and `cmd /c` on Windows
 * (its embedded docs), so a leading assignment works on both with the right
 * syntax. hooks.json is rewritten per spawn, so the socket path is current.
 */
/**
 * POSIX single-quote. Everything inside '' is literal to sh — including $,
 * backticks and \ — and an embedded ' is handled by closing, escaping and
 * reopening ('\'').
 *
 * JSON.stringify is NOT safe here despite looking like it is: it emits DOUBLE
 * quotes, and `sh -c` still expands $(...) and backticks inside those. An
 * Obsidian vault is user-named and its path reaches us verbatim, so a folder
 * called `My $(...) Vault` would execute at hook-registration time.
 */
function _shQuote(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * Characters that cannot appear in a value interpolated into the Windows
 * shim BODY. Inside a .cmd, `%` begins variable expansion and `"` terminates
 * a quoted assignment. A Windows path cannot contain `"`, but `%` is a legal
 * folder-name character and an Obsidian vault is user-named, so a vault at
 * `C:\100% Done\…` must be declined rather than turned into a shim that
 * expands something at hook time.
 */
const WIN_SHIM_UNSAFE = /["%\r\n]/;

/**
 * Why Windows gets a shim file instead of an inline command.
 *
 * Antigravity executes a hook command through Go's `os/exec`, which quotes
 * arguments using the C-runtime convention: an embedded `"` is emitted as
 * `\"`. `cmd.exe` does not implement that convention — it treats `\"` as a
 * literal quote character. So a command containing a quoted interpreter path
 * arrives at cmd with the quotes welded into the filename:
 *
 *   '"C:\Program Files\nodejs\node.exe"' is not recognized as an internal or
 *   external command
 *
 * Captured from agy v1.1.8's own log on a Windows VM (2026-07-30). The hook
 * exited 1 and agy allowed the tool anyway — a failed hook is an ALLOW — so
 * the protected write it was meant to block succeeded.
 *
 * There is no escaping that survives both layers, so the command must contain
 * NO double quote at all. That in turn means it cannot contain a space, since
 * a space is what forces a quote. A file path satisfies both if we choose the
 * path; the quoted interpreter and script paths live INSIDE the file, where
 * nothing re-escapes them.
 *
 * Verified on the Windows VM by invoking each candidate form the way agy does
 * (Go-style escaping) rather than the way a human types it at a prompt: the
 * bare shim path and a short-path form both reached the IPC server and denied;
 * the inline form and a QUOTED shim path both failed with the error above.
 */
function _winShimPath(ipcSocketPath: string): string | null {
  // Per-socket, so two vaults spawning concurrently write two shims and
  // neither can rewrite the other's out from under a live turn.
  const tag = crypto.createHash("sha256").update(ipcSocketPath).digest("hex").slice(0, 12);

  // PER-USER ONLY. The shim is a script agy executes with this user's
  // privileges, so where it lives is a security boundary, not a convenience.
  //
  // An earlier revision of this function fell back to %ProgramData% when
  // %LOCALAPPDATA% contained a space. That is a machine-wide directory: on a
  // multi-user Windows box another local account could overwrite the .cmd and
  // get arbitrary code execution as this user the next time any tool call
  // fired. A local privilege escalation, introduced to dodge a quoting rule.
  //
  // %LOCALAPPDATA% is inside the user profile and inherits its ACL, so it is
  // the only acceptable home. A spaced profile ("C:\Users\Jane Smith\...")
  // still needs a space-free command, which is what the 8.3 short name
  // provides — and an 8.3 alias of a per-user path is still per-user.
  const base = process.env.LOCALAPPDATA;
  if (!base) return null;

  const dir = path.join(base, "gryphon", "agy-hooks");
  const direct = path.join(dir, `pretool-${tag}.cmd`);
  if (!direct.includes(" ") && !direct.includes('"')) return direct;

  // Spaced profile: 8.3 requires the directory to exist before it has a
  // short name, so create it first.
  try { fs.mkdirSync(dir, { recursive: true }); } catch { return null; }
  const short = _shortPathOf(dir);
  if (short && !short.includes(" ") && !short.includes('"')) {
    return path.join(short, `pretool-${tag}.cmd`);
  }
  return null;
}

/**
 * Windows 8.3 short name for an existing directory, or null.
 *
 * Node exposes no GetShortPathName binding, so this shells out to `for %I in
 * (...) do @echo %~sI`. 8.3 generation can be disabled per volume
 * (`fsutil 8dot3name`), in which case cmd echoes the long path back and the
 * caller must decline rather than emit a command it cannot quote.
 */
function _shortPathOf(dir: string): string | null {
  try {
    const { spawnSync } = require("child_process") as typeof import("child_process");
    // windowsVerbatimArguments: the argument contains quotes, and default
    // escaping would render them as \" — which cmd reads literally. That is
    // the exact defect this whole shim exists to work around, so it must not
    // be reintroduced in the code that computes the shim's path.
    const r = spawnSync(
      "cmd",
      ["/c", `for %I in ("${dir}") do @echo %~sI`],
      { encoding: "utf8", timeout: 5000, windowsVerbatimArguments: true },
    );
    if (!r || r.status !== 0) return null;
    const line = String(r.stdout || "").trim().split(/\r?\n/)[0];
    return line && !line.includes("%") ? line : null;
  } catch {
    return null;
  }
}

function _writeWinShim(
  shimPath: string, nodePath: string, scriptPath: string, ipcSocketPath: string,
): boolean {
  const body = [
    "@echo off",
    `set "GRYPHON_HOOK_DIALECT=antigravity"`,
    `set "GRYPHON_HOOK_PROVIDER=${KIND}"`,
    `set "GRYPHON_PERMISSION_SOCKET=${ipcSocketPath}"`,
    `"${nodePath}" "${scriptPath}"`,
    "",
  ].join("\r\n");
  try {
    fs.mkdirSync(path.dirname(shimPath), { recursive: true });
    fs.writeFileSync(shimPath, body, { mode: 0o600 });
    return true;
  } catch (e) {
    console.warn(
      `[gryphon/antigravity-hooks] could not write the hook shim ${shimPath}: ` +
      `${(e as Error).message}`,
    );
    return false;
  }
}

function _makeCommand(nodePath: string, scriptPath: string, ipcSocketPath: string): string | null {
  const env: Array<[string, string]> = [
    ["GRYPHON_HOOK_DIALECT", "antigravity"],
    ["GRYPHON_HOOK_PROVIDER", KIND],
    ["GRYPHON_PERMISSION_SOCKET", ipcSocketPath],
  ];
  if (process.platform === "win32") {
    for (const v of [nodePath, scriptPath, ipcSocketPath]) {
      if (WIN_SHIM_UNSAFE.test(v)) {
        console.warn(
          `[gryphon/antigravity-hooks] refusing to build a hook command: ` +
          `"${v}" contains a character that cannot be embedded in a cmd shim. ` +
          `Move the vault (or the CLI) to a path without " or %.`,
        );
        return null;
      }
    }
    const shimPath = _winShimPath(ipcSocketPath);
    if (!shimPath) {
      console.warn(
        `[gryphon/antigravity-hooks] refusing to build a hook command: no ` +
        `space-free location for the hook shim (tried LOCALAPPDATA and ` +
        `ProgramData). Antigravity's hook command cannot contain a quote, and ` +
        `a space would require one.`,
      );
      return null;
    }
    if (!_writeWinShim(shimPath, nodePath, scriptPath, ipcSocketPath)) return null;
    return shimPath;
  }
  const assigns = env.map(([k, v]) => `${k}=${_shQuote(v)}`).join(" ");
  return `${assigns} ${_shQuote(nodePath)} ${_shQuote(scriptPath)}`;
}

/**
 * Build the hook spec stored under our key.
 *
 * Timeout is in SECONDS. Antigravity's embedded docs: "Execution timeout in
 * seconds. Defaults to 30." This differs from Gemini, whose identically
 * named field is milliseconds — copying Gemini's `* 1000` here would set a
 * multi-day timeout, and taking Antigravity's 30s default would fire a
 * default-allow long before a user finishes reading the approve/deny modal
 * (the exact bug reported against Gemini on 2026-05-03).
 */
function _buildHookEntry(
  { pluginDir, nodePath, ipcSocketPath = "" }:
  { pluginDir: string; nodePath: string; ipcSocketPath?: string },
) {
  const hooksDir = path.join(pluginDir, "hooks");
  const pre = _makeCommand(nodePath, path.join(hooksDir, String(HOOK_FILES.PreToolUse)), ipcSocketPath);
  if (!pre) return null;

  // NO PostToolUse. Captured live from agy v1.1.8, its PostToolUse payload is
  //   { toolCall: null, error: "", stepIdx, conversationId, workspacePaths, … }
  // — no tool call, and no tool OUTPUT of any kind. posttool.js exists solely
  // to wrap tool results in untrusted-content framing (the prompt-injection
  // hardening from v2.6.1), and there is nothing here to wrap. Registering it
  // anyway would install a hook that fires, reads nothing and returns nothing,
  // while showing up in the config as protection that exists.
  //
  // Consequence worth stating plainly: content Antigravity pulls in mid-turn
  // (a fetched page, a file it read) is NOT untrusted-framed. Closing that
  // needs framing applied in the provider's own event-stream parsing, the way
  // the anthropic-api path does it — not a hook.
  return {
    PreToolUse: [{
      // Match-all. Gating only `run_command` would leave every file-mutating
      // tool (write_to_file, replace_file_content, delete_directory)
      // ungated, and protected PATHS are half of what Gryphon enforces.
      matcher: "*",
      hooks: [{
        type: "command",
        command: pre,
        timeout: DEFAULT_HOOK_TIMEOUTS.PreToolUse,
      }],
    }],
  };
}

/**
 * Recover the IPC socket baked into an installed hook entry, so cleanup can
 * tell "the key I installed" from "a key another vault installed after me".
 */
function _socketOf(entry: unknown): string | null {
  try {
    const cmd = (entry as any)?.PreToolUse?.[0]?.hooks?.[0]?.command;
    if (typeof cmd !== "string") return null;
    const m = cmd.match(/GRYPHON_PERMISSION_SOCKET=(?:'((?:[^']|'\\'')*)'|"([^"]*)")/);
    if (m) return (m[1] !== undefined ? m[1].replace(/'\\''/g, "'") : m[2]) || null;
    // Windows: the command is a bare path to our shim, so the socket lives in
    // the shim's body. Without this the multi-vault guard silently degrades to
    // "no recoverable owner", and a cleanup would strip a live vault's key.
    return _socketOfShim(cmd);
  } catch {
    return null;
  }
}

/** Recover the socket from a shim file named by `cmd`, if that is what it is. */
function _socketOfShim(cmd: string): string | null {
  if (!/\.cmd$/i.test(cmd)) return null;
  try {
    const body = fs.readFileSync(cmd, "utf8");
    const m = body.match(/set "GRYPHON_PERMISSION_SOCKET=([^"]*)"/);
    return (m && m[1]) || null;
  } catch {
    return null;   // shim already gone; caller treats as unknown owner
  }
}

/**
 * Read the shared hooks.json. Returns null when it is absent OR unparseable
 * — callers must treat null as "do not touch this file".
 */
function _readHooks(file: string): Record<string, unknown> | null {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;  // absent
  }
  try {
    const json = JSON.parse(raw);
    return (json && typeof json === "object" && !Array.isArray(json)) ? json : null;
  } catch (e) {
    console.warn(
      `[gryphon/antigravity-hooks] ${file} is not valid JSON — leaving it untouched ` +
      `and running without hook enforcement (${(e as Error).message})`,
    );
    return null;
  }
}

/**
 * Write atomically: temp file in the same directory, then rename over the
 * target. rename(2) is atomic within a filesystem, so a crash mid-write can
 * never leave the user with a truncated hooks.json. This file is THEIRS and
 * shared with their own interactive `agy` — corrupting it would be a worse
 * outcome than never installing the hook.
 */
function _writeHooks(file: string, json: Record<string, unknown>) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.gryphon-hooks-${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(json, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw e;
  }
}

/**
 * Merge our key into `file`. Exported unbound from the real path so tests
 * never touch the user's global config.
 */
function _installInto(
  file: string,
  { pluginDir, nodePath, ipcSocketPath = "" }:
  { pluginDir: string; nodePath: string; ipcSocketPath?: string },
): boolean {
  const existing = _readHooks(file);
  if (existing === null && fs.existsSync(file)) {
    // Unparseable — rule 3 in the header. Degrade rather than destroy.
    return false;
  }
  const json = existing || {};
  const entry = _buildHookEntry({ pluginDir, nodePath, ipcSocketPath });
  if (!entry) return false;   // unquotable path — degrade, never emit an injectable command
  json[HOOK_KEY] = entry;
  try {
    _writeHooks(file, json);
    return true;
  } catch (e) {
    console.warn(`[gryphon/antigravity-hooks] failed to write ${file}: ${(e as Error).message}`);
    return false;
  }
}

/**
 * Remove ONLY our key. Deletes the file when our key was its sole content, so
 * an install/uninstall cycle is a true no-op on the user's config.
 *
 * `ownedSocket` guards the multi-vault case. Two Obsidian windows share this
 * one file: vault B's spawn overwrites the key with B's socket, then vault A
 * finishes and cleans up. A blind delete would strip B's guardrail mid-turn,
 * leaving a provider running with auto-approve and nothing gating it. So a
 * per-spawn cleanup only removes the key if it is still the one it installed.
 * Pass nothing to force removal (self-heal path).
 */
function _uninstallFrom(file: string, ownedSocket?: string): boolean {
  const json = _readHooks(file);
  if (!json) return false;
  if (!(HOOK_KEY in json)) return false;
  if (ownedSocket) {
    const installed = _socketOf(json[HOOK_KEY]);
    if (installed && installed !== ownedSocket) {
      // Another live Gryphon owns the key now. Leave it alone.
      return false;
    }
  }
  // Remove the shim too, before dropping the key that names it — otherwise
  // every spawn leaves a .cmd behind in LOCALAPPDATA forever.
  const shim = (json[HOOK_KEY] as any)?.PreToolUse?.[0]?.hooks?.[0]?.command;
  if (typeof shim === "string" && /\.cmd$/i.test(shim)) {
    try { fs.unlinkSync(shim); } catch { /* already gone, or never ours */ }
  }
  delete json[HOOK_KEY];
  try {
    if (Object.keys(json).length === 0) {
      fs.unlinkSync(file);
    } else {
      _writeHooks(file, json);
    }
    return true;
  } catch (e) {
    console.warn(`[gryphon/antigravity-hooks] failed to clean ${file}: ${(e as Error).message}`);
    return false;
  }
}

/**
 * Self-heal: drop a key left behind by a crash. Identical mechanics to
 * uninstall; named separately because the intent (and the logging) differ —
 * this one runs when we do NOT expect to own the key.
 */
function _stripStaleFrom(file: string): boolean {
  const removed = _uninstallFrom(file);
  if (removed) {
    console.warn(
      `[gryphon/antigravity-hooks] cleared a stale "${HOOK_KEY}" hook left in ${file} ` +
      `by a previous session — your own \`agy\` runs are no longer gated by it`,
    );
  }
  return removed;
}

/** Public self-heal entry point — call on plugin load. */
function stripStaleHooks(): boolean {
  return _stripStaleFrom(hooksFilePath());
}

/**
 * Adapter contract — see hook-dispatcher.ts.
 *
 * Unlike the other adapters this adds no CLI args: `agy` has no flag that
 * points at a hooks file, so installation IS the wiring.
 *
 * @param _hooksFile test seam — overrides the global path.
 */
function buildSpawnExtras(
  { pluginDir, ipcSocketPath, nodePath, _hooksFile }:
  { pluginDir: string; ipcSocketPath: string; nodePath: string; _hooksFile?: string },
) {
  if (!pluginDir || !ipcSocketPath || !nodePath) {
    return null;
  }
  const file = _hooksFile || hooksFilePath();

  // Clear a stale key before installing: if a prior crash left one, the
  // install below would overwrite it anyway, but doing it explicitly keeps
  // the "we only ever own one key" invariant auditable.
  _stripStaleFrom(file);
  // A failed install must not read as success. _installInto returns false for
  // an unparseable user hooks.json, an unwritable config dir, or a path we
  // refuse to build a command for -- in every one of those cases there is no
  // guardrail, and the caller has to know that before it decides whether to
  // pass --dangerously-skip-permissions.
  if (!_installInto(file, { pluginDir, nodePath, ipcSocketPath })) return null;

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    // Ownership-scoped: if another vault's spawn has since overwritten the
    // key with its own socket, leave it — removing it would un-gate a live
    // session in the other window.
    _uninstallFrom(file, ipcSocketPath);
  };

  return {
    env: {
      GRYPHON_PERMISSION_SOCKET: ipcSocketPath,
      // Tells pretool.ts to parse Antigravity's camelCase `toolCall`
      // payload and emit its flat {decision, reason} output.
      GRYPHON_HOOK_DIALECT: "antigravity",
      GRYPHON_HOOK_PROVIDER: KIND,
    },
    args: [],
    cleanup,
    hooksFile: file,
  };
}

module.exports = {
  kind: KIND,
  buildSpawnExtras,
  hooksFilePath,
  stripStaleHooks,
  HOOK_KEY,
  _buildHookEntry,
  _socketOf,
  _installInto,
  _uninstallFrom,
  _stripStaleFrom,
};
