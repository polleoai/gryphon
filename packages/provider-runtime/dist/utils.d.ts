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
declare function clearBinaryDiscoveryCache(): void;
declare function parseVersion(raw: unknown): number[] | null;
declare function compareVersions(a: number[], b: number[]): number;
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
declare function _versionProbeTimeoutFor(binPath: string): number;
declare function _versionSignatureFor(binName: string): RegExp | undefined;
declare function probeVersion(binPath: string, run?: (p: string) => string, signature?: RegExp): number[] | null;
declare function _pickNewestValid(present: string[], minVersion: string, signature?: RegExp): {
    path: string;
    version: number[];
} | null;
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
declare function _findClaudeBinaryCached(): string | null;
declare function _collectPresentBinaries(candidates: (string | undefined)[], binName: string, isWindows: boolean): string[];
/**
 * Locate a real `node` binary for hook scripts to run under. In Obsidian,
 * `process.execPath` is the Electron renderer binary, which cannot execute
 * a plain JS file from argv — handing that to the CLI's hook `command`
 * silently fails. We probe common Node install locations, fall back to
 * PATH, and finally try the user's login shell.
 */
declare function _findNodeBinaryCached(): string | null;
declare function _findViaLoginShell(binName: string, runner?: (shell: string, args: string[]) => string): string | null;
/**
 * Locate the OpenAI Codex CLI. Same search pattern as findClaudeBinary,
 * with one extra macOS-specific candidate: the Codex.app bundle ships
 * the binary at /Applications/Codex.app/Contents/Resources/codex, which
 * isn't on PATH unless the user explicitly symlinks it.
 *
 * Returns absolute path or null. Cached.
 */
declare function _findCodexBinaryCached(): string | null;
/**
 * Locate the Google Gemini CLI. Search pattern matches findClaudeBinary.
 * Returns absolute path or null. Cached.
 */
declare function _findGeminiBinaryCached(): string | null;
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
declare function _findAntigravityBinaryCached(): string | null;
declare function buildEnhancedPath(): string;
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
declare function detectFlatpakSandbox(): {
    isFlatpak: boolean;
    appId: string | null;
};
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
declare function displayPath(p: string): string;
declare function displayPath(p: unknown): unknown;
type ResolveResult = {
    ok: true;
    path: string;
    version: number[];
} | {
    ok: false;
    error: "not-found" | "too-old";
    detail: string;
};
/**
 * The binary finders every caller goes through: this module's own resolution
 * (_detectFor) and other modules, via the exported wrappers below. It is the
 * one replaceable seam — a test substitutes a finder here, because ESM exports
 * are read-only bindings and can't be patched in place.
 */
declare const binaryFinders: {
    findClaudeBinary: typeof _findClaudeBinaryCached;
    findCodexBinary: typeof _findCodexBinaryCached;
    findGeminiBinary: typeof _findGeminiBinaryCached;
    findAntigravityBinary: typeof _findAntigravityBinaryCached;
    findNodeBinary: typeof _findNodeBinaryCached;
};
declare function findClaudeBinary(): string | null;
declare function findCodexBinary(): string | null;
declare function findGeminiBinary(): string | null;
declare function findAntigravityBinary(): string | null;
declare function findNodeBinary(): string | null;
declare function resolveCliBinary(kind: string, configuredPath?: string, minVersionOverride?: string, opts?: {
    vaultRoot?: string | null;
}): ResolveResult;
export { binaryFinders, findClaudeBinary, findCodexBinary, findGeminiBinary, findAntigravityBinary, findNodeBinary, buildEnhancedPath, detectFlatpakSandbox, clearBinaryDiscoveryCache, displayPath, parseVersion, compareVersions, probeVersion, _versionProbeTimeoutFor, resolveCliBinary, _pickNewestValid, _collectPresentBinaries, _versionSignatureFor, _findViaLoginShell, };
