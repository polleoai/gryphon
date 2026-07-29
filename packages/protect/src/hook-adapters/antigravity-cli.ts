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
const {
  DEFAULT_HOOK_TIMEOUTS,
  HOOK_FILES,
  POSTTOOL_MATCHER,
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
function _makeCommand(nodePath: string, scriptPath: string, ipcSocketPath: string): string {
  const env = {
    GRYPHON_HOOK_DIALECT: "antigravity",
    GRYPHON_HOOK_PROVIDER: KIND,
    GRYPHON_PERMISSION_SOCKET: ipcSocketPath,
  };
  if (process.platform === "win32") {
    const sets = Object.entries(env).map(([k, v]) => `set "${k}=${v}"`).join(" && ");
    return `${sets} && "${nodePath}" "${scriptPath}"`;
  }
  const assigns = Object.entries(env)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(" ");
  return `${assigns} ${JSON.stringify(nodePath)} ${JSON.stringify(scriptPath)}`;
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
  const post = _makeCommand(nodePath, path.join(hooksDir, String(HOOK_FILES.PostToolUse)), ipcSocketPath);

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
    PostToolUse: [{
      matcher: POSTTOOL_MATCHER || "*",
      hooks: [{
        type: "command",
        command: post,
        timeout: DEFAULT_HOOK_TIMEOUTS.PostToolUse,
      }],
    }],
  };
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

function _writeHooks(file: string, json: Record<string, unknown>) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(json, null, 2), { mode: 0o600 });
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
  json[HOOK_KEY] = _buildHookEntry({ pluginDir, nodePath, ipcSocketPath });
  try {
    _writeHooks(file, json);
    return true;
  } catch (e) {
    console.warn(`[gryphon/antigravity-hooks] failed to write ${file}: ${(e as Error).message}`);
    return false;
  }
}

/**
 * Remove ONLY our key. Deletes the file when our key was its sole content,
 * so an install/uninstall cycle is a true no-op on the user's config.
 */
function _uninstallFrom(file: string): boolean {
  const json = _readHooks(file);
  if (!json) return false;
  if (!(HOOK_KEY in json)) return false;
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
  _installInto(file, { pluginDir, nodePath, ipcSocketPath });

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    _uninstallFrom(file);
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
  _installInto,
  _uninstallFrom,
  _stripStaleFrom,
};
