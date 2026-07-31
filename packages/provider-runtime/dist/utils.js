"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");
// Module-level caches. `undefined` means "not yet probed"; a string or
// null means "probed, got this result". Explicit-undefined sentinel lets
// null be a valid cached answer (= known not found).
let _claudeBinaryCache;
let _nodeBinaryCache;
let _codexBinaryCache;
let _geminiBinaryCache;
let _antigravityBinaryCache;
let _flatpakCache;
// Absolute-path → parsed [major,minor,patch] (or null = probe failed). Keyed
// by path so repeated resolution across providers pays one --version spawn.
let _versionCache = {};
// binName → login-shell `command -v` result (path or null). The login-shell
// fallback spawns `$SHELL -lc ...`, so cache it per name: now that find*Binary
// no longer caches a null detection (so a cold-start miss self-heals), the
// cheap candidate-list + --version probe re-run each call, but this expensive
// shell spawn must NOT. Cleared by clearBinaryDiscoveryCache (Re-detect).
let _loginShellCache = {};
function clearBinaryDiscoveryCache() {
    _claudeBinaryCache = undefined;
    _nodeBinaryCache = undefined;
    _codexBinaryCache = undefined;
    _geminiBinaryCache = undefined;
    _antigravityBinaryCache = undefined;
    _flatpakCache = undefined;
    _versionCache = {};
    _loginShellCache = {};
}
// Minimum CLI versions Gryphon's spawn protocol supports. Permissive
// ("0.0.0" = accept any parseable version): newest-on-disk ranking already
// fixes the stale-binary case, so the floor rejects nothing today. Raise a
// floor only when a provider starts depending on a newer CLI capability —
// in the same change that introduces the dependency.
const MIN_CLAUDE_VERSION = "0.0.0";
const MIN_CODEX_VERSION = "0.0.0";
const MIN_GEMINI_VERSION = "0.0.0";
const MIN_ANTIGRAVITY_VERSION = "0.0.0";
// Parse the first dotted numeric version (2- or 3-part) out of arbitrary
// CLI `--version` output. Returns [major, minor, patch] or null.
//   "2.1.181 (Claude Code)" → [2,1,181] ; "codex 0.9" → [0,9,0]
function parseVersion(raw) {
    if (typeof raw !== "string")
        return null;
    const m = raw.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
    if (!m)
        return null;
    return [Number(m[1]), Number(m[2]), Number(m[3] || 0)];
}
// Compare two [major,minor,patch] arrays; missing parts count as 0.
// Negative if a < b, positive if a > b, 0 if equal.
function compareVersions(a, b) {
    for (let i = 0; i < 3; i++) {
        const d = (a[i] || 0) - (b[i] || 0);
        if (d !== 0)
            return d;
    }
    return 0;
}
// Run `<binPath> --version` and return its raw stdout. Windows .cmd/.bat
// shims need a shell. Factored out so probeVersion can be unit-tested with
// an injected runner (no real spawns).
// 1500ms bounds worst-case preflight latency (probes run serially) while
// still tolerating a slow cold-start. A `--version` that takes longer than
// this is itself a strong "discard this candidate" signal — real CLIs answer
// in well under 200ms.
const _VERSION_PROBE_TIMEOUT_MS = 1500;
/**
 * Budget for large single-file CLI binaries — see _versionProbeTimeoutFor.
 *
 * 5000ms, NOT something roomier, and the ceiling is deliberate. This probe is
 * `execFileSync` and `findAntigravityBinary` is called from the settings view
 * (settings-view.ts), i.e. on Obsidian's RENDERER thread — the budget is a
 * worst-case UI freeze, not just a latency bound. Failed probes are also
 * deliberately not cached (see probeVersion), so a genuinely hung binary
 * re-freezes on every subsequent call rather than once.
 *
 * 5000ms clears the measured 3071ms cold start with ~1.6x headroom while
 * keeping the worst case survivable. Raising it trades a rare false
 * "not detected" for a frequent multi-second hang, which is the worse bug.
 */
const _VERSION_PROBE_TIMEOUT_LARGE_MS = 5000;
/** `agy` is ~179MB; `claude`/`codex` shims are kilobytes. 50MB separates them cleanly. */
const _LARGE_BINARY_BYTES = 50 * 1024 * 1024;
/**
 * How long `<bin> --version` may take before we give up on it.
 *
 * This is not a cosmetic budget: probeVersion DISCARDS any candidate whose
 * version it cannot read, so a probe that times out is indistinguishable from
 * "not installed" and the CLI shows as undetected while sitting on disk.
 *
 * A flat 1500ms suited `claude` and `codex`, which ship small JS shims. It
 * does not suit `agy`: a ~179MB Go binary whose cold-cache start was measured
 * at **3071ms** on the Debian VM right after boot (379/436ms once warm), and
 * 263ms on a fast Mac with a warm cache — which is why host testing never saw
 * it. The failure lands on exactly the users least able to diagnose it: slow
 * disks, network volumes, first launch after a reboot.
 *
 * Scaling by file size rather than by CLI name means the next large binary is
 * covered without anyone remembering to add it to a list.
 *
 * Caveat: on Windows a candidate may be a small `.cmd` shim that launches a
 * large `.exe`, in which case the shim's size understates the real cost. That
 * is not the case for `agy` (the installer registers `agy.exe` directly), but
 * a future shim-based CLI would need naming rather than sizing.
 */
function _versionProbeTimeoutFor(binPath) {
    try {
        if (fs.statSync(binPath).size >= _LARGE_BINARY_BYTES) {
            return _VERSION_PROBE_TIMEOUT_LARGE_MS;
        }
    }
    catch {
        // Unstattable (gone, permission denied) — the probe is about to fail for
        // its own reasons; the default budget is the right answer.
    }
    return _VERSION_PROBE_TIMEOUT_MS;
}
function _runVersion(binPath) {
    const isWinShim = process.platform === "win32" && /\.(cmd|bat)$/i.test(binPath);
    // Windows .cmd/.bat shims must run through a shell. Under shell:true Node
    // builds an UNQUOTED command line ("<path> --version"), so a path with
    // spaces (e.g. C:\Program Files\nodejs\claude.cmd — a default candidate)
    // would fail; quote the path so cmd parses it as one token.
    const file = isWinShim ? `"${binPath}"` : binPath;
    return execFileSync(file, ["--version"], {
        timeout: _versionProbeTimeoutFor(binPath),
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        env: { ...process.env, PATH: buildEnhancedPath() },
        shell: isWinShim,
    });
}
// Probe a binary's version synchronously and cache by absolute path. Returns
// [maj,min,patch] or null (missing / non-responding / garbage output). `run`
// is injectable for tests; production uses the real execFileSync wrapper.
function probeVersion(binPath, run = _runVersion) {
    if (Object.prototype.hasOwnProperty.call(_versionCache, binPath)) {
        return _versionCache[binPath];
    }
    let parsed = null;
    try {
        parsed = parseVersion(run(binPath));
    }
    catch (e) {
        // execFileSync throws on nonzero exit / timeout but attaches the captured
        // streams; some CLIs print `--version` to stderr.
        const tail = (e && e.stdout && e.stdout.toString()) ||
            (e && e.stderr && e.stderr.toString()) ||
            "";
        parsed = parseVersion(tail);
    }
    // Cache ONLY a successful parse. A null here means a transient miss — a
    // cold-start `--version` that exceeded the probe timeout, or momentary
    // garbage — and must NOT be cached, or one cold first probe poisons
    // detection for the whole session (the gemini "not found" bug). Leaving it
    // uncached lets the next probe re-run and self-heal once warm.
    if (parsed)
        _versionCache[binPath] = parsed;
    return parsed;
}
// From a list of existing executable paths, return the newest whose
// `--version` parses and is >= floor, as { path, version }, or null.
function _pickNewestValid(present, minVersion) {
    const floor = parseVersion(minVersion) || [0, 0, 0];
    let best = null;
    for (const p of present) {
        const v = probeVersion(p);
        if (!v)
            continue; // unparseable / dead → discard
        if (compareVersions(v, floor) < 0)
            continue; // below floor → reject
        if (!best || compareVersions(v, best.version) > 0)
            best = { path: p, version: v };
    }
    return best;
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
    // Only a successful (truthy) detection is cached; a null is a transient miss
    // (cold-start probe timeout) that must re-run next call so it self-heals.
    if (_claudeBinaryCache)
        return _claudeBinaryCache;
    _claudeBinaryCache = _findClaudeBinaryUncached();
    return _claudeBinaryCache;
}
// Collect ALL existing executable candidates for a CLI: the explicit
// location list, then the PATH scan (platform-correct extensions), then the
// login-shell hit (unless Windows / Flatpak, same guards as before). Order
// preserved, deduped. This is the input set to version-aware ranking — it
// replaces the previous "return the first executable" short-circuit (R6).
function _collectPresentBinaries(candidates, binName, isWindows) {
    const present = [];
    const seen = new Set();
    const add = (c) => {
        if (!c || seen.has(c))
            return;
        try {
            fs.accessSync(c, fs.constants.X_OK);
            seen.add(c);
            present.push(c);
        }
        catch { }
    };
    for (const c of candidates)
        add(c);
    const exts = isWindows ? [".cmd", ".exe", ".bat", ""] : [""];
    for (const dir of (process.env.PATH || "").split(path.delimiter)) {
        if (!dir)
            continue;
        for (const ext of exts)
            add(path.join(dir, binName + ext));
    }
    // Login-shell fallback catches nvm / asdf / rbenv / custom prefixes the
    // Obsidian process PATH misses. Skip in Flatpak (sandbox shell can't see
    // host PATH) and on Windows (cmd/PowerShell don't source rc files; system
    // PATH is already visible to Node).
    if (!(isWindows || detectFlatpakSandbox().isFlatpak))
        add(_findViaLoginShell(binName));
    return present;
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
        "/usr/bin/claude", // apt / dpkg / sudo npm -g
        "/opt/homebrew/bin/claude", // macOS Apple-silicon Homebrew
        "/usr/local/opt/claude/bin/claude", // macOS Intel Homebrew variant
        "/snap/bin/claude", // Snap package
        "/var/lib/flatpak/exports/bin/claude", // Flatpak-installed CLI
        "/Applications/Claude.app/Contents/MacOS/claude",
        // Windows common install locations:
        path.join(process.env.APPDATA || "", "npm", "claude.cmd"),
        path.join(process.env.APPDATA || "", "npm", "claude.exe"),
        path.join(process.env.LOCALAPPDATA || "", "Programs", "claude", "claude.exe"),
        "C:\\Program Files\\nodejs\\claude.cmd",
        "C:\\Program Files\\nodejs\\claude.exe",
    ];
    // Version-aware: probe every present candidate's --version and return the
    // NEWEST that satisfies the floor — not the first merely-executable one.
    // A stale binary that exists (or sorts earlier) no longer shadows a current
    // install elsewhere on the system (R2/R3).
    const present = _collectPresentBinaries(candidates, "claude", isWindows);
    const best = _pickNewestValid(present, MIN_CLAUDE_VERSION);
    return best ? best.path : null;
}
/**
 * Locate a real `node` binary for hook scripts to run under. In Obsidian,
 * `process.execPath` is the Electron renderer binary, which cannot execute
 * a plain JS file from argv — handing that to the CLI's hook `command`
 * silently fails. We probe common Node install locations, fall back to
 * PATH, and finally try the user's login shell.
 */
function findNodeBinary() {
    if (_nodeBinaryCache !== undefined)
        return _nodeBinaryCache;
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
        path.join(home, ".nvm", "versions", "node"), // nvm root (probed below)
        path.join(home, ".npm-global", "bin", "node"),
        path.join(home, ".volta", "bin", "node"),
        "/usr/bin/node",
        "/snap/bin/node",
        // Windows locations:
        "C:\\Program Files\\nodejs\\node.exe",
        path.join(process.env.LOCALAPPDATA || "", "fnm_multishells"), // fnm (probed below)
        path.join(process.env.APPDATA || "", "nvm"), // nvm-windows (probed below)
    ];
    for (const c of candidates) {
        if (!c)
            continue;
        try {
            const stat = fs.statSync(c);
            if (stat.isFile()) {
                try {
                    fs.accessSync(c, fs.constants.X_OK);
                    return c;
                }
                catch { }
            }
            else if (stat.isDirectory()) {
                // nvm-style version manager: pick highest version dir that has
                // bin/node (POSIX) or node.exe (Windows).
                const entries = fs.readdirSync(c).sort().reverse();
                for (const v of entries) {
                    const sub = path.join(c, v);
                    const cand = isWindows
                        ? path.join(sub, "node.exe")
                        : path.join(sub, "bin", "node");
                    try {
                        fs.accessSync(cand, fs.constants.X_OK);
                        return cand;
                    }
                    catch { }
                }
            }
        }
        catch { }
    }
    const exts = isWindows ? [".exe", ".cmd", ""] : [""];
    for (const dir of (process.env.PATH || "").split(path.delimiter)) {
        if (!dir)
            continue;
        for (const ext of exts) {
            const c = path.join(dir, "node" + ext);
            try {
                fs.accessSync(c, fs.constants.X_OK);
                return c;
            }
            catch { }
        }
    }
    if (isWindows || detectFlatpakSandbox().isFlatpak)
        return null;
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
// Default runner: a real login-shell `command -v` spawn. Injectable (param on
// _findViaLoginShell) so tests can simulate a cold-start timeout vs a clean
// miss without forking a shell.
function _defaultLoginShellRunner(shell, args) {
    return execFileSync(shell, args, {
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
    });
}
function _findViaLoginShell(binName, runner = _defaultLoginShellRunner) {
    if (Object.prototype.hasOwnProperty.call(_loginShellCache, binName)) {
        return _loginShellCache[binName];
    }
    const { path, definitive } = _findViaLoginShellUncached(binName, runner);
    // Cache ONLY a DEFINITIVE result. A transient failure (the login-shell spawn
    // timed out or errored on a cold start) is NOT cached, so the next call
    // re-probes and self-heals — mirroring find*Binary's truthy-only rule and
    // closing the gemini "not found" bug class one layer down. A clean miss
    // (shell ran, `command -v` found nothing) IS cached: re-spawning a login
    // shell on every readiness poll for a genuinely-absent binary is a real cost.
    if (definitive)
        _loginShellCache[binName] = path;
    return path;
}
function _findViaLoginShellUncached(binName, runner) {
    const shell = process.env.SHELL || "/bin/bash";
    // Can't even reach the shell → transient (don't cache; it may appear later).
    try {
        fs.accessSync(shell, fs.constants.X_OK);
    }
    catch {
        return { path: null, definitive: false };
    }
    let out;
    try {
        out = runner(shell, ["-lc", `command -v ${binName}`]);
    }
    catch (e) {
        // Distinguish a clean "not found" from a transient failure. A non-zero
        // EXIT (e.status is a number) means the shell ran and `command -v` reported
        // the binary absent → DEFINITIVE (cacheable). A timeout / kill / spawn
        // error has no numeric exit status → TRANSIENT (cold start) → do NOT cache.
        const cleanExit = e && typeof e.status === "number" && !e.killed && e.code !== "ETIMEDOUT";
        return { path: null, definitive: !!cleanExit };
    }
    // `command -v` may print the alias form ("alias x='...'") if the binary is a
    // shell alias. Look for the first line that's an absolute path pointing at an
    // executable file.
    for (const line of (out || "").split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("/")) {
            try {
                fs.accessSync(trimmed, fs.constants.X_OK);
                return { path: trimmed, definitive: true };
            }
            catch { /* not executable — keep looking */ }
        }
    }
    // Shell ran cleanly but printed no usable path → binary genuinely absent.
    return { path: null, definitive: true };
}
/**
 * Locate the OpenAI Codex CLI. Same search pattern as findClaudeBinary,
 * with one extra macOS-specific candidate: the Codex.app bundle ships
 * the binary at /Applications/Codex.app/Contents/Resources/codex, which
 * isn't on PATH unless the user explicitly symlinks it.
 *
 * Returns absolute path or null. Cached.
 */
function findCodexBinary() {
    if (_codexBinaryCache)
        return _codexBinaryCache;
    _codexBinaryCache = _findCodexBinaryUncached();
    return _codexBinaryCache;
}
function _findCodexBinaryUncached() {
    const home = os.homedir();
    const isWindows = process.platform === "win32";
    const candidates = [
        // User-level installs (npm-global, volta, bun, etc.)
        path.join(home, ".local", "bin", "codex"),
        path.join(home, ".npm-global", "bin", "codex"),
        path.join(home, ".volta", "bin", "codex"),
        path.join(home, ".bun", "bin", "codex"),
        path.join(home, "node_modules", ".bin", "codex"),
        // macOS app bundle — primary install path on Mac. Codex.app
        // ships the CLI at this location and the user often hasn't
        // symlinked it onto PATH.
        "/Applications/Codex.app/Contents/Resources/codex",
        // System-level installs:
        "/opt/homebrew/bin/codex",
        "/usr/local/bin/codex",
        "/usr/bin/codex",
        "/snap/bin/codex",
        // Windows common install locations:
        path.join(process.env.APPDATA || "", "npm", "codex.cmd"),
        path.join(process.env.APPDATA || "", "npm", "codex.exe"),
        path.join(process.env.LOCALAPPDATA || "", "Programs", "codex", "codex.exe"),
        "C:\\Program Files\\nodejs\\codex.cmd",
        "C:\\Program Files\\nodejs\\codex.exe",
    ];
    // Version-aware: newest valid install wins (R2/R3) — identical algorithm
    // to findClaudeBinary; codex has the same stale-binary exposure.
    const present = _collectPresentBinaries(candidates, "codex", isWindows);
    const best = _pickNewestValid(present, MIN_CODEX_VERSION);
    return best ? best.path : null;
}
/**
 * Locate the Google Gemini CLI. Search pattern matches findClaudeBinary.
 * Returns absolute path or null. Cached.
 */
function findGeminiBinary() {
    if (_geminiBinaryCache)
        return _geminiBinaryCache;
    _geminiBinaryCache = _findGeminiBinaryUncached();
    return _geminiBinaryCache;
}
function _findGeminiBinaryUncached() {
    const home = os.homedir();
    const isWindows = process.platform === "win32";
    const candidates = [
        path.join(home, ".local", "bin", "gemini"),
        path.join(home, ".npm-global", "bin", "gemini"),
        path.join(home, ".volta", "bin", "gemini"),
        path.join(home, ".bun", "bin", "gemini"),
        path.join(home, "node_modules", ".bin", "gemini"),
        "/opt/homebrew/bin/gemini",
        "/usr/local/bin/gemini",
        "/usr/bin/gemini",
        "/snap/bin/gemini",
        path.join(process.env.APPDATA || "", "npm", "gemini.cmd"),
        path.join(process.env.APPDATA || "", "npm", "gemini.exe"),
        "C:\\Program Files\\nodejs\\gemini.cmd",
        "C:\\Program Files\\nodejs\\gemini.exe",
    ];
    // Version-aware: newest valid install wins (R2/R3) — identical algorithm
    // to findClaudeBinary; gemini has the same stale-binary exposure.
    const present = _collectPresentBinaries(candidates, "gemini", isWindows);
    const best = _pickNewestValid(present, MIN_GEMINI_VERSION);
    return best ? best.path : null;
}
/**
 * Locate the Google Antigravity CLI (`agy`). Unlike claude/codex/gemini,
 * Antigravity ships as a single Go binary installed via
 * `curl -fsSL https://antigravity.google/cli/install.sh | bash` — there is
 * no Node/npm involved, so none of the npm-global/volta/bun candidate
 * prefixes the other three finders use apply here.
 *
 * The installer's default target (verified against
 * antigravity.google/cli/install.sh and antigravity.google/docs/cli/install,
 * 2026-07-27) is `$HOME/.local/bin/agy` on macOS/Linux and
 * `%LOCALAPPDATA%\agy\bin\agy.exe` on Windows. Both support a `--dir`
 * override the user may have used at install time; the login-shell PATH
 * fallback inside `_collectPresentBinaries` still catches that case, same
 * as it does for the other three CLIs.
 *
 * Returns absolute path or null. Cached.
 */
function findAntigravityBinary() {
    // `!== undefined`, not truthiness: null is a CACHED MISS. A truthy check
    // re-runs the whole filesystem + login-shell PATH scan on every readiness
    // poll and factory call whenever `agy` isn't installed — which is the
    // common case for most users.
    if (_antigravityBinaryCache !== undefined)
        return _antigravityBinaryCache;
    _antigravityBinaryCache = _findAntigravityBinaryUncached();
    return _antigravityBinaryCache;
}
function _findAntigravityBinaryUncached() {
    const home = os.homedir();
    const isWindows = process.platform === "win32";
    const candidates = [
        // Canonical installer target (curl | bash default).
        path.join(home, ".local", "bin", "agy"),
        // Speculative fallbacks in case a future package manager (brew tap,
        // apt, a custom --dir install) lands it elsewhere — same defensive
        // breadth as the other three find*Binary functions. No npm/volta/bun
        // paths: Antigravity is not an npm package.
        "/opt/homebrew/bin/agy",
        "/usr/local/bin/agy",
        "/usr/bin/agy",
        "/snap/bin/agy",
        // Windows: installer registers to %LOCALAPPDATA%\agy\bin\agy.exe.
        path.join(process.env.LOCALAPPDATA || "", "agy", "bin", "agy.exe"),
        "C:\\Program Files\\agy\\agy.exe",
    ];
    // Version-aware: newest valid install wins (R2/R3) — identical algorithm
    // to findClaudeBinary; antigravity has the same stale-binary exposure.
    const present = _collectPresentBinaries(candidates, "agy", isWindows);
    const best = _pickNewestValid(present, MIN_ANTIGRAVITY_VERSION);
    return best ? best.path : null;
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
    if (_flatpakCache !== undefined)
        return _flatpakCache;
    if (process.env.FLATPAK_ID) {
        _flatpakCache = { isFlatpak: true, appId: process.env.FLATPAK_ID };
        return _flatpakCache;
    }
    try {
        if (fs.existsSync("/.flatpak-info")) {
            _flatpakCache = { isFlatpak: true, appId: "(unknown)" };
            return _flatpakCache;
        }
    }
    catch { }
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
    if (typeof p !== "string" || !p)
        return p;
    const home = os.homedir();
    if (!home)
        return p;
    const sep = path.sep;
    if (p === home)
        return "~";
    if (p.startsWith(home + sep))
        return "~" + p.slice(home.length);
    return p;
}
const _MIN_BY_KIND = {
    "claude-code": MIN_CLAUDE_VERSION,
    "codex-cli": MIN_CODEX_VERSION,
    "gemini-cli": MIN_GEMINI_VERSION,
    "antigravity-cli": MIN_ANTIGRAVITY_VERSION,
};
const _LABEL_BY_KIND = {
    "claude-code": "claude",
    "codex-cli": "codex",
    "gemini-cli": "gemini",
    "antigravity-cli": "agy",
};
// Dispatch detection through module.exports (not the local fn refs) so the
// finder stays patchable at runtime — tests reassign utils.findClaudeBinary,
// and this picks up the override. Same rationale factory.ts documents for
// re-reading require("./utils").find* fresh on each call.
function _detectFor(kind) {
    if (kind === "claude-code")
        return module.exports.findClaudeBinary();
    if (kind === "codex-cli")
        return module.exports.findCodexBinary();
    if (kind === "gemini-cli")
        return module.exports.findGeminiBinary();
    if (kind === "antigravity-cli")
        return module.exports.findAntigravityBinary();
    return null;
}
/**
 * Resolve a usable CLI binary for a provider kind — the spawn-preflight verb
 * (R1/R4/R5/R7). Order:
 *   1. An explicit, valid, version-OK configured path wins (R7 override).
 *   2. Otherwise self-heal to the newest detected install (R4) — find*Binary
 *      already ranks by version (R2/R3).
 *   3. If nothing valid, return a typed failure the caller turns into a fast,
 *      actionable message (R5): "too-old" when a present binary is below the
 *      floor, else "not-found".
 *
 * Pure resolution: never spawns the model, only `--version` probes (cached).
 */
function resolveCliBinary(kind, configuredPath, minVersionOverride) {
    // minVersionOverride lets a caller (or a test) impose a stricter floor than
    // the permissive per-kind default; the default keeps the too-old gate dormant.
    const min = minVersionOverride || _MIN_BY_KIND[kind] || "0.0.0";
    const floor = parseVersion(min) || [0, 0, 0];
    const label = _LABEL_BY_KIND[kind] || kind;
    // R7: an explicit, valid, version-OK configured path wins outright.
    if (typeof configuredPath === "string" && configuredPath) {
        let executable = false;
        try {
            fs.accessSync(configuredPath, fs.constants.X_OK);
            executable = true;
        }
        catch { }
        if (executable) {
            const v = probeVersion(configuredPath);
            if (v && compareVersions(v, floor) >= 0) {
                return { ok: true, path: configuredPath, version: v };
            }
            // configured exists but is too old / unparseable → fall through to
            // detection (R4 self-heal); the too-old detail is reported below only
            // if detection also turns up nothing.
        }
    }
    // find*Binary ranks by the DEFAULT (permissive) floor, so re-validate the
    // detected binary against the (possibly overridden) floor here.
    const detected = _detectFor(kind);
    if (detected) {
        const v = probeVersion(detected) || [0, 0, 0];
        if (compareVersions(v, floor) >= 0) {
            return { ok: true, path: detected, version: v };
        }
        // detected but below the overridden floor → fall through to too-old.
    }
    // Nothing valid anywhere. Report too-old when a present binary (configured
    // or detected) parses but sits below the floor; else not-found.
    const cfgV = (typeof configuredPath === "string" && configuredPath) ? probeVersion(configuredPath) : null;
    const detV = detected ? probeVersion(detected) : null;
    const belowFloor = (cfgV && compareVersions(cfgV, floor) < 0 && cfgV) ||
        (detV && compareVersions(detV, floor) < 0 && detV) ||
        null;
    if (belowFloor) {
        return { ok: false, error: "too-old", detail: `${label} v${belowFloor.join(".")} (< required v${min})` };
    }
    return { ok: false, error: "not-found", detail: label };
}
module.exports = {
    findClaudeBinary,
    findCodexBinary,
    findGeminiBinary,
    findAntigravityBinary,
    findNodeBinary,
    buildEnhancedPath,
    detectFlatpakSandbox,
    clearBinaryDiscoveryCache,
    displayPath,
    // Version-aware resolution (v2.4.3)
    parseVersion,
    compareVersions,
    probeVersion,
    _versionProbeTimeoutFor,
    resolveCliBinary,
    // Exported for unit tests (internal ranking primitives).
    _pickNewestValid,
    _collectPresentBinaries,
    _findViaLoginShell,
};
