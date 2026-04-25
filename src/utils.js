/**
 * Shared utilities for the Gryphon plugin.
 *
 *   findClaudeBinary     — Locate the `claude` CLI the user already installed
 *   findNodeBinary       — Locate a real `node` binary for hook scripts to run
 *   buildEnhancedPath    — PATH env with common binary locations prepended
 *   detectFlatpakSandbox — Detect if Obsidian is running inside Flatpak
 *
 * The discovery helpers are cache-aware so callers can hit them repeatedly
 * without paying shell-spawn costs. `clearBinaryDiscoveryCache()` is the
 * escape hatch for a "re-detect" button or a settings-reload flow.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");

// Module-level caches. `undefined` means "not yet probed"; a string or
// null means "probed, got this result". Explicit-undefined sentinel lets
// null be a valid cached answer (= known not found).
let _claudeBinaryCache;
let _nodeBinaryCache;
let _flatpakCache;

function clearBinaryDiscoveryCache() {
  _claudeBinaryCache = undefined;
  _nodeBinaryCache = undefined;
  _flatpakCache = undefined;
}

/**
 * Locate the `claude` CLI the user has already installed. Returns an
 * absolute path, or null if nothing found.
 *
 * Search order:
 *   1. Common user-level install locations (inside $HOME — accessible
 *      to both unsandboxed AND Flatpak-sandboxed Obsidian)
 *   2. Common system-level locations (only reachable without a sandbox)
 *   3. Obsidian's own process.env.PATH — typically minimal when Obsidian
 *      is launched from a desktop entry rather than a shell
 *   4. The user's login-shell PATH — catches nvm/asdf/rbenv/volta
 *      installations and custom prefixes that never reach Electron's env
 *
 * Cached after the first call. Use `clearBinaryDiscoveryCache()` to
 * force a fresh probe (e.g. from a "re-detect" settings button).
 */
function findClaudeBinary() {
  if (_claudeBinaryCache !== undefined) return _claudeBinaryCache;
  _claudeBinaryCache = _findClaudeBinaryUncached();
  return _claudeBinaryCache;
}

function _findClaudeBinaryUncached() {
  const home = os.homedir();
  const isWindows = process.platform === "win32";
  const candidates = [
    // User-level installs (inside $HOME — Flatpak-accessible via the
    // --filesystem=home grant documented in our install guide):
    path.join(home, ".local", "bin", "claude"),
    path.join(home, ".claude", "local", "claude"),
    path.join(home, ".npm-global", "bin", "claude"),
    path.join(home, "node_modules", ".bin", "claude"),
    path.join(home, ".volta", "bin", "claude"),
    path.join(home, ".bun", "bin", "claude"),
    // System-level installs (reachable when Obsidian is not sandboxed;
    // unreachable from Flatpak without a --filesystem=/usr grant):
    "/usr/local/bin/claude",
    "/usr/bin/claude",                        // apt / dpkg / sudo npm -g
    "/opt/homebrew/bin/claude",               // macOS Apple-silicon Homebrew
    "/usr/local/opt/claude/bin/claude",       // macOS Intel Homebrew variant
    "/snap/bin/claude",                       // Snap package
    "/var/lib/flatpak/exports/bin/claude",    // Flatpak-installed CLI
    "/Applications/Claude.app/Contents/MacOS/claude",
    // Windows common install locations:
    path.join(process.env.APPDATA || "", "npm", "claude.cmd"),
    path.join(process.env.APPDATA || "", "npm", "claude.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Programs", "claude", "claude.exe"),
    "C:\\Program Files\\nodejs\\claude.cmd",
    "C:\\Program Files\\nodejs\\claude.exe",
  ];
  for (const c of candidates) {
    if (!c) continue;
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch {}
  }
  // PATH fallback. On Windows the binary name includes an extension
  // (claude.cmd for npm shims, claude.exe for native builds); on POSIX
  // it's bare. Iterate the right suffix list for the platform.
  const exts = isWindows ? [".cmd", ".exe", ".bat", ""] : [""];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const c = path.join(dir, "claude" + ext);
      try { fs.accessSync(c, fs.constants.X_OK); return c; } catch {}
    }
  }
  // Final fallback: ask the user's login shell. Catches installations in
  // nvm / asdf / rbenv / custom prefixes — anywhere the user's shell
  // PATH exposes `claude` that Obsidian's own process doesn't see.
  // Skip this in Flatpak (sandbox shell can't see host PATH) and on
  // Windows (cmd/PowerShell don't source rc files the same way; the
  // system PATH is already available to Node).
  if (isWindows || detectFlatpakSandbox().isFlatpak) return null;
  return _findViaLoginShell("claude");
}

/**
 * Locate a real `node` binary for hook scripts to run under. In Obsidian,
 * `process.execPath` is the Electron renderer binary, which cannot execute
 * a plain JS file from argv — handing that to the CLI's hook `command`
 * silently fails. We probe common Node install locations, fall back to
 * PATH, and finally try the user's login shell.
 */
function findNodeBinary() {
  if (_nodeBinaryCache !== undefined) return _nodeBinaryCache;
  _nodeBinaryCache = _findNodeBinaryUncached();
  return _nodeBinaryCache;
}

function _findNodeBinaryUncached() {
  const home = os.homedir();
  const isWindows = process.platform === "win32";
  const candidates = [
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    path.join(home, ".local", "bin", "node"),
    path.join(home, ".nvm", "versions", "node"),   // nvm root (probed below)
    path.join(home, ".npm-global", "bin", "node"),
    path.join(home, ".volta", "bin", "node"),
    "/usr/bin/node",
    "/snap/bin/node",
    // Windows locations:
    "C:\\Program Files\\nodejs\\node.exe",
    path.join(process.env.LOCALAPPDATA || "", "fnm_multishells"),  // fnm (probed below)
    path.join(process.env.APPDATA || "", "nvm"),                   // nvm-windows (probed below)
  ];
  for (const c of candidates) {
    if (!c) continue;
    try {
      const stat = fs.statSync(c);
      if (stat.isFile()) {
        try { fs.accessSync(c, fs.constants.X_OK); return c; } catch {}
      } else if (stat.isDirectory()) {
        // nvm-style version manager: pick highest version dir that has
        // bin/node (POSIX) or node.exe (Windows).
        const entries = fs.readdirSync(c).sort().reverse();
        for (const v of entries) {
          const sub = path.join(c, v);
          const cand = isWindows
            ? path.join(sub, "node.exe")
            : path.join(sub, "bin", "node");
          try { fs.accessSync(cand, fs.constants.X_OK); return cand; } catch {}
        }
      }
    } catch {}
  }
  const exts = isWindows ? [".exe", ".cmd", ""] : [""];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const c = path.join(dir, "node" + ext);
      try { fs.accessSync(c, fs.constants.X_OK); return c; } catch {}
    }
  }
  if (isWindows || detectFlatpakSandbox().isFlatpak) return null;
  return _findViaLoginShell("node");
}

/**
 * Ask the user's login shell to locate a binary by name. Spawns
 * `$SHELL -lc 'command -v <bin>'` with a short timeout. Returns the
 * absolute path if found and executable, else null.
 *
 * The `-l` flag means "login shell", which sources the user's rc files
 * (~/.zshrc, ~/.bashrc, ~/.profile) — this is the bit Obsidian's own
 * process.env.PATH misses when Obsidian is launched from a desktop
 * entry or dock rather than a shell session. `command -v` is POSIX so
 * works across bash/zsh/dash; it prints the resolved path on success.
 */
function _findViaLoginShell(binName) {
  const shell = process.env.SHELL || "/bin/bash";
  try { fs.accessSync(shell, fs.constants.X_OK); }
  catch { return null; }
  try {
    const out = execFileSync(
      shell,
      ["-lc", `command -v ${binName}`],
      {
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
      },
    );
    // `command -v` may print the alias form ("alias x='...'") if the
    // binary is a shell alias. Look for the first line that's an
    // absolute path pointing at an executable file.
    for (const line of out.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("/")) {
        try { fs.accessSync(trimmed, fs.constants.X_OK); return trimmed; }
        catch { /* not executable — keep looking */ }
      }
    }
    return null;
  } catch {
    // Timed out, shell exited non-zero (binary not found), or similar.
    return null;
  }
}

function buildEnhancedPath() {
  const home = os.homedir();
  return [
    path.join(home, ".local", "bin"), "/opt/homebrew/bin",
    "/usr/local/bin", path.join(home, ".npm-global", "bin"),
    "/usr/bin", "/bin", "/usr/sbin", "/sbin",
    process.env.PATH || "",
  ].join(path.delimiter);
}

/**
 * Detect whether Obsidian (and therefore Gryphon) is running inside a
 * Flatpak sandbox. Two independent signals — the env var is the
 * standard Flatpak contract, the info file is a fallback for contexts
 * where the env isn't preserved. Returns `{ isFlatpak, appId }`.
 *
 * Used to tailor CLI-mode diagnostic messages: inside a sandbox,
 * `claude` installed at /usr/bin is invisible to the plugin, and the
 * "not found" error should say why rather than be generic.
 */
function detectFlatpakSandbox() {
  if (_flatpakCache !== undefined) return _flatpakCache;
  if (process.env.FLATPAK_ID) {
    _flatpakCache = { isFlatpak: true, appId: process.env.FLATPAK_ID };
    return _flatpakCache;
  }
  try {
    if (fs.existsSync("/.flatpak-info")) {
      _flatpakCache = { isFlatpak: true, appId: "(unknown)" };
      return _flatpakCache;
    }
  } catch {}
  _flatpakCache = { isFlatpak: false, appId: null };
  return _flatpakCache;
}

/**
 * Collapse the user's home-directory prefix in a filesystem path to `~`
 * so the OS username isn't exposed in UI strings, detection pills,
 * welcome cards, or screenshots. Unchanged if the path is outside
 * home or if `home` is unknown.
 *
 * Example:
 *   displayPath("/Users/alice/.npm-global/bin/claude")
 *     → "~/.npm-global/bin/claude"
 *
 * Screenshot exposure is the concrete risk this guards against —
 * the welcome card and Settings CLI-path pill both render detection
 * results that could otherwise leak the OS username into README
 * screenshots and demo recordings.
 */
function displayPath(p) {
  if (typeof p !== "string" || !p) return p;
  const home = os.homedir();
  if (!home) return p;
  const sep = path.sep;
  if (p === home) return "~";
  if (p.startsWith(home + sep)) return "~" + p.slice(home.length);
  return p;
}

module.exports = {
  findClaudeBinary,
  findNodeBinary,
  buildEnhancedPath,
  detectFlatpakSandbox,
  clearBinaryDiscoveryCache,
  displayPath,
};
