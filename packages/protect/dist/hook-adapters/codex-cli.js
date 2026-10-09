"use strict";
// TypeScript module marker.
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Codex CLI hook adapter.
 *
 * Codex CLI v0.117.0+ implements Claude Code's hook protocol verbatim
 * — same JSON wire format, same env vars (CLAUDE_PLUGIN_ROOT etc.).
 * The only differences from the claude-code adapter:
 *
 *   1. Config file format: TOML (in `<CODEX_HOME>/config.toml`) vs.
 *      JSON (passed via `--settings`).
 *   2. Spawn-time wiring: env var (`CODEX_HOME`) vs. CLI flag.
 *   3. Auth preservation: Codex's `auth.json` lives in the user's real
 *      `~/.codex/`. Pointing `CODEX_HOME` at our tmpdir would break
 *      login, so we symlink `auth.json` (and a few related files)
 *      from the real home into our overlay.
 *
 * The hook scripts themselves (`hooks/pretool.js`, `hooks/posttool.js`,
 * etc.) are reused unchanged — Codex consumes them with the same
 * stdin/stdout JSON contract Claude Code uses.
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { hookCommandLine } = require("../../../provider-runtime/dist/shell-quote");
const { DEFAULT_HOOK_TIMEOUTS, HOOK_FILES, POSTTOOL_MATCHER, } = require("../../../provider-runtime/dist/providers/claude-code/hook-settings-builder");
const { GRYPHON_SYSTEM_PROMPT_HINT, GRYPHON_FALLBACK_DENY_HINT, } = require("../system-prompt-hints");
const { storeGuardCommand, STORE_GUARD_TIMEOUT_S } = require("./store-guard-command");
const KIND = "codex-cli";
// Files we symlink from the real ~/.codex/ into our overlay so Codex
// retains login state and can resume prior sessions. Kept minimal:
//
//   auth.json     — required for ChatGPT/API auth (Codex 401s without it)
//   sessions/     — required for `codex exec resume <thread_id>` to find
//                   the prior session JSONL
//   models_cache.json — performance optimization (Codex re-fetches
//                   without it but the model list URL request is slow);
//                   safe to symlink because it's read-only metadata
//
// We deliberately do NOT preserve plugins/, skills/, marketplaces/,
// or sqlite state files. Those carry user-side mutable state that
// could conflict between Gryphon's overlay and the user's interactive
// `codex` use, AND surprisingly Codex enters a degraded mode when it
// sees inconsistent state.sqlite (turn.completed with no agent_message).
//
// Empirically determined: with the larger symlink list, Codex spawns
// and authenticates but produces no model output. With this minimal
// list it works correctly. Re-add entries one at a time only if a
// real user-reported feature regresses.
const PRESERVED_FROM_REAL_HOME = [
    "auth.json",
    "sessions",
    "models_cache.json",
];
/**
 * R2-2: a TOML basic string. JSON.stringify is close but not TOML: it
 * leaves U+007F raw (forbidden in TOML) and emits \uDXXX for a lone
 * surrogate (also invalid). Vault paths reach these strings, and an invalid
 * config makes Codex refuse to start — so encode DEL, and refuse a string
 * that can't be represented at all.
 */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
function _tomlString(s) {
    if (LONE_SURROGATE_RE.test(s))
        throw new Error("path can't be written to Codex's config (unpaired surrogate)");
    return JSON.stringify(s).replace(/\u007f/g, "\\u007F");
}
/**
 * R3-1: Codex applies the PROJECT config layer — a `.codex/config.toml` in
 * the vault or any folder above it up to the repo root — even under
 * `codex exec` with an overlay CODEX_HOME, and that layer can start
 * `mcp_servers` at session start (no tool call, so no hook) or widen the
 * sandbox (`sandbox_workspace_write.writable_roots`). Verified live, codex
 * 0.145: a vault's MCP server ran on a plain "say hi". Marking the vault and
 * every folder above it untrusted in OUR user layer stops Codex from
 * applying those layers (a `-c projects…` override did not). These entries
 * live only in Gryphon's per-spawn overlay; the user's own ~/.codex is
 * untouched.
 */
function _projectTrustToml(projectDir) {
    if (!projectDir || typeof projectDir !== "string")
        return "";
    const dirs = new Set();
    const starts = [path.resolve(projectDir)];
    try {
        starts.push(fs.realpathSync.native(projectDir));
    }
    catch { /* missing */ }
    try {
        starts.push(fs.realpathSync(projectDir));
    }
    catch { /* missing */ }
    for (const start of starts) {
        let cur = start;
        for (let i = 0; i < 256; i++) {
            dirs.add(cur);
            const parent = path.dirname(cur);
            if (parent === cur)
                break;
            cur = parent;
        }
    }
    let toml = "";
    for (const d of dirs) {
        try {
            toml += `[projects.${_tomlString(d)}]\ntrust_level = "untrusted"\n\n`;
        }
        catch {
            // An unencodable folder name: without its entry Codex would apply
            // that folder's project config, so refuse the whole overlay.
            throw new Error(`Gryphon can't safely start Codex in ${JSON.stringify(projectDir)}`);
        }
    }
    return toml;
}
/**
 * Render one [[hooks.<EventName>]] block in TOML form.
 *
 * Codex's TOML config schema mirrors Claude Code's JSON exactly:
 *   [[hooks.PreToolUse]]
 *   matcher = "regex"
 *
 *   [[hooks.PreToolUse.hooks]]
 *   type = "command"
 *   command = "..."
 *   timeout = 300
 */
function _renderHookBlock(eventName, matcher, command, timeout) {
    return [
        `[[hooks.${eventName}]]`,
        `matcher = ${_tomlString(matcher)}`,
        ``,
        `[[hooks.${eventName}.hooks]]`,
        `type = "command"`,
        `command = ${_tomlString(command)}`,
        `timeout = ${timeout}`,
        ``,
    ].join("\n");
}
/**
 * Issue #31: Codex ≥ 0.145 runs a configured hook only once it is
 * TRUSTED — `[hooks.state."<key>"] trusted_hash = "<hash>"` in the same
 * config layer — and silently skips untrusted hooks. Our overlay is
 * fresh per spawn, so without this every Gryphon hook was skipped and
 * every tool call was allowed. Gryphon wrote these hooks itself, so it
 * vouches for exactly them (and nothing else) instead of passing
 * `--dangerously-bypass-hook-trust`, which would trust any hook.
 *
 * Mirrors codex-rs `hooks/src/engine/discovery.rs` (`command_hook_hash`,
 * `hook_key`) and `config/src/fingerprint.rs` (`version_for_toml`) at
 * rust-v0.145.0: sha256 over sorted-key compact JSON of
 * `{event_name, matcher, hooks:[normalized handler]}`, where the handler
 * omits unset options and its timeout is normalized the way Codex does.
 */
/**
 * R43-2: a vault's own `.codex/config.toml` (Codex's project layer) could set
 * `[features] hooks = false` (or the `codex_hooks` alias) and switch off every
 * Gryphon hook. Command-line `-c` overrides rank above the project layer, so
 * every spawn that carries Gryphon hooks forces the feature back on.
 */
const CODEX_FORCE_HOOKS_ARGS = ["-c", "features.hooks=true"];
const CODEX_EVENT_LABELS = {
    PreToolUse: "pre_tool_use",
    PostToolUse: "post_tool_use",
    SessionStart: "session_start",
    SessionEnd: "session_end",
    UserPromptSubmit: "user_prompt_submit",
};
const CODEX_SESSION_END_MAX_TIMEOUT_SEC = 3;
// hooks/src/events/common.rs matcher_pattern_for_event @ rust-v0.145.0.
const CODEX_MATCHERLESS_EVENTS = new Set(["UserPromptSubmit", "Stop"]);
function _canonicalJson(v) {
    if (Array.isArray(v))
        return v.map(_canonicalJson);
    if (v && typeof v === "object") {
        const out = {};
        for (const k of Object.keys(v).sort())
            out[k] = _canonicalJson(v[k]);
        return out;
    }
    return v;
}
function _codexNormalizedTimeout(eventName, timeout) {
    if (eventName === "SessionEnd")
        return Math.min(Math.max(timeout, 1), CODEX_SESSION_END_MAX_TIMEOUT_SEC);
    return Math.max(timeout, 1);
}
/** Codex's trust hash for one command hook (null for an event Codex doesn't know). */
function _codexHookTrustHash(eventName, matcher, command, timeout) {
    const label = CODEX_EVENT_LABELS[eventName];
    if (!label)
        return null;
    // R43-5: Codex hashes UserPromptSubmit and Stop with NO matcher
    // (matcher_pattern_for_event → None), so the key is omitted, not "".
    const identity = {
        event_name: label,
        ...(CODEX_MATCHERLESS_EVENTS.has(eventName) ? {} : { matcher }),
        hooks: [{ type: "command", command, timeout: _codexNormalizedTimeout(eventName, timeout), async: false }],
    };
    return "sha256:" + crypto.createHash("sha256").update(JSON.stringify(_canonicalJson(identity))).digest("hex");
}
/**
 * The `[hooks.state]` tables that trust each rendered hook. Each event
 * has exactly one matcher group with one handler, so its key is
 * `<configPath>:<label>:0:0`. `configPath` must be the exact path Codex
 * will read (the overlay is built under a realpath for this reason).
 */
function _renderTrustState(configPath, hooks) {
    let toml = "";
    for (const [eventName, matcher, command, timeout] of hooks) {
        const hash = _codexHookTrustHash(eventName, matcher, command, timeout);
        if (!hash)
            continue;
        const key = `${configPath}:${CODEX_EVENT_LABELS[eventName]}:0:0`;
        toml += `[hooks.state.${_tomlString(key)}]\ntrusted_hash = ${_tomlString(hash)}\n\n`;
    }
    return toml;
}
/**
 * Convert GRYPHON_SYSTEM_PROMPT_HINT (newline-free, "·"-bulleted)
 * into a markdown document suitable for Codex's
 * `model_instructions_file` config. Codex prepends/uses this file
 * as additional model instructions at session creation time.
 *
 * The hint already enforces no-embedded-newlines for shell-arg
 * compatibility on Windows; for the file path we don't need that
 * constraint, so we expand the bullets into proper markdown for
 * better model adherence (LLMs follow visually-formatted bullets
 * more reliably than inline "·" separators).
 */
function _buildModelInstructions() {
    const bullets = GRYPHON_SYSTEM_PROMPT_HINT.split("· ").map((s) => s.trim()).filter(Boolean);
    const head = bullets[0];
    const rest = bullets.slice(1).map((b) => `- ${b}`).join("\n\n");
    return [
        "# Gryphon — environment-specific instructions",
        "",
        head,
        "",
        rest,
        "",
        "## On terse environment refusals (fallback path)",
        "",
        GRYPHON_FALLBACK_DENY_HINT.replace(/^· /, ""),
        "",
    ].join("\n");
}
/**
 * Build the canonical hook-config TOML string. Mirrors the JSON shape
 * `buildHookSettings` returns for claude-code, just rendered in TOML.
 *
 * Also references the model_instructions_file (written by
 * _createCodexHomeOverlay) so Codex's model receives Gryphon's
 * anti-leak + compound-request directives on every session.
 */
function _buildHooksToml({ pluginDir, nodePath, modelInstructionsFile, configPath }) {
    const hooksDir = path.join(pluginDir, "hooks");
    const isWindows = process.platform === "win32";
    // Per-platform command quoting: same logic as the claude-code hook
    // builder. POSIX uses JSON-quoted bash tokens; Windows uses
    // single-quoted PowerShell paths inside an `&` invocation.
    const makeCommand = (scriptName) => {
        const scriptPath = path.join(hooksDir, scriptName);
        // R43-1: real shell quoting (the script path is under the vault folder,
        // and #31 makes Codex trust exactly this string).
        return hookCommandLine(nodePath, scriptPath, isWindows ? "win32" : process.platform);
    };
    const events = [
        ["PreToolUse", "", HOOK_FILES.PreToolUse],
        ["PostToolUse", POSTTOOL_MATCHER, HOOK_FILES.PostToolUse],
        ["SessionStart", "", HOOK_FILES.SessionStart],
        ["SessionEnd", "", HOOK_FILES.SessionEnd],
        ["UserPromptSubmit", "", HOOK_FILES.UserPromptSubmit],
        ["Notification", "", HOOK_FILES.Notification],
    ];
    // Header: Codex distinguishes [hooks] (single table) from
    // [[hooks.<event>]] (array of tables). Each event can have multiple
    // matcher/command groups.
    let toml = "# Gryphon-managed Codex hook config (regenerated per spawn).\n\n";
    // Point Codex at our model-instructions file. The directives in that
    // file are essential for clean refusal UX (no "PreToolUse hook"
    // wording leaks) and the compound-request rule (complete safe sub-
    // tasks even when one is refused).
    if (modelInstructionsFile) {
        toml += `model_instructions_file = ${_tomlString(modelInstructionsFile)}\n\n`;
    }
    const rendered = [];
    for (const [event, matcher, scriptName] of events) {
        const cmd = makeCommand(scriptName);
        toml += _renderHookBlock(event, matcher, cmd, DEFAULT_HOOK_TIMEOUTS[event]);
        toml += "\n";
        rendered.push([event, matcher, cmd, DEFAULT_HOOK_TIMEOUTS[event]]);
    }
    if (configPath)
        toml += _renderTrustState(configPath, rendered);
    return toml;
}
/**
 * Issue #30: store-guard-only config — a single PreToolUse hook, nothing
 * else (no other events, no model instructions). Protected Mode is off, so
 * the only thing Gryphon adds is the trust-store check.
 */
function _buildStoreGuardToml({ nodePath, storeGuard, configPath }) {
    const { command } = storeGuardCommand({ nodePath, scriptPath: storeGuard.scriptPath, approvalsDir: storeGuard.approvalsDir, dialect: "codex" });
    // #31: an untrusted hook is skipped silently by Codex, so the guard must be trusted too.
    return "# Gryphon-managed Codex hook config (regenerated per spawn): store guard only.\n\n" +
        _renderHookBlock("PreToolUse", "", command, STORE_GUARD_TIMEOUT_S) + "\n" +
        (configPath ? _renderTrustState(configPath, [["PreToolUse", "", command, STORE_GUARD_TIMEOUT_S]]) : "");
}
/**
 * Create a CODEX_HOME overlay directory: a fresh tmpdir containing our
 * config.toml plus symlinks to the user's real auth/session/plugin
 * artifacts. Returns the absolute path to the overlay.
 *
 * The overlay is per-spawn — each `codex exec` invocation gets its
 * own tmpdir, cleaned up on close. This isolates Gryphon's hook
 * config from the user's interactive `codex` use, and protects
 * against multi-vault cross-contamination.
 */
function _createCodexHomeOverlay({ pluginDir, nodePath, storeGuard, projectDir, trustOnly }) {
    const realHome = path.join(os.homedir(), ".codex");
    const rand = crypto.randomBytes(4).toString("hex");
    // Realpath: Codex keys hook trust by the config path it reads, and on
    // macOS os.tmpdir() (/var/folders/…) is a symlink to /private/var/….
    // R43-13: the NATIVE realpath, which (unlike JS realpathSync) expands
    // Windows 8.3 short names (C:\Users\RUNNER~1 → C:\Users\runneradmin) the way
    // Codex canonicalizes CODEX_HOME — otherwise the trust keys don't match
    // and Codex skips every hook. Same result as realpathSync elsewhere.
    let tmpBase = os.tmpdir();
    try {
        tmpBase = fs.realpathSync.native(tmpBase);
    }
    catch {
        try {
            tmpBase = fs.realpathSync(tmpBase);
        }
        catch { /* keep os.tmpdir() */ }
    }
    const overlay = path.join(tmpBase, `gryphon-codex-home-${process.pid}-${Date.now()}-${rand}`);
    fs.mkdirSync(overlay, { recursive: true, mode: 0o700 });
    // Symlink each preserved entry from the real home if it exists.
    // Symlinks (vs. copies) keep auth-token rotation, session history,
    // and plugin updates in sync with the user's real Codex state with
    // zero additional bookkeeping.
    for (const name of PRESERVED_FROM_REAL_HOME) {
        const real = path.join(realHome, name);
        const linkPath = path.join(overlay, name);
        if (!fs.existsSync(real))
            continue;
        try {
            fs.symlinkSync(real, linkPath);
        }
        catch (e) {
            // EEXIST shouldn't happen (fresh tmpdir), EPERM on Windows when
            // not running as admin — fall through to copyFile for the
            // small/critical files (auth.json), warn for the rest.
            if (e.code === "EPERM" && (name === "auth.json" || name === "session_index.jsonl")) {
                try {
                    fs.copyFileSync(real, linkPath);
                }
                catch (e2) {
                    console.warn(`[gryphon/codex-hooks] couldn't preserve ${name}: ${e2.message}`);
                }
            }
            else if (e.code !== "EEXIST") {
                console.warn(`[gryphon/codex-hooks] symlink ${name} failed: ${e.message}`);
            }
        }
    }
    // Write the model-instructions file FIRST so config.toml can
    // reference it by absolute path. Codex loads this file at session
    // creation and surfaces its content as additional model instructions
    // — it's how we get the "no hook leak / complete safe sub-requests"
    // directives in front of the Codex model.
    //
    // QA-V13H-A: if either write throws (disk full, EPERM, antivirus
    // mid-scan), tear down the partially-built overlay so the tmpdir
    // doesn't leak. `buildSpawnExtras` returns null/throws on failure
    // and the caller never gets the cleanup callback — without this
    // rollback every failed spawn leaves a 4-KB stub in tmpdir.
    try {
        const trust = _projectTrustToml(projectDir);
        if (trustOnly) {
            // R3-1: hooks couldn't be set up, but the vault's own Codex config
            // must still not apply.
            fs.writeFileSync(path.join(overlay, "config.toml"), "# Gryphon-managed Codex config (regenerated per spawn): project trust only.\n\n" + trust, { flag: "wx", mode: 0o600 });
            return overlay;
        }
        if (storeGuard) {
            const sgConfigPath = path.join(overlay, "config.toml");
            fs.writeFileSync(sgConfigPath, _buildStoreGuardToml({ nodePath: nodePath, storeGuard, configPath: sgConfigPath }) + trust, { flag: "wx", mode: 0o600 });
            return overlay;
        }
        const modelInstructionsFile = path.join(overlay, "model-instructions.md");
        fs.writeFileSync(modelInstructionsFile, _buildModelInstructions(), {
            flag: "wx",
            mode: 0o600,
        });
        // Write our config.toml — this is the file Codex reads to discover
        // the hook commands and the model_instructions_file pointer. The
        // user's real config.toml is intentionally NOT preserved; Gryphon
        // owns the hook + model-instructions section and the rest defaults
        // are fine for our use.
        const configPath = path.join(overlay, "config.toml");
        fs.writeFileSync(configPath, _buildHooksToml({ pluginDir: pluginDir, nodePath: nodePath, modelInstructionsFile, configPath }) + trust, { flag: "wx", mode: 0o600 });
    }
    catch (e) {
        _cleanupOverlay(overlay);
        throw e;
    }
    return overlay;
}
/**
 * Recursive cleanup: remove the overlay directory tree (symlinks +
 * config.toml). Best-effort — a leftover overlay in tmpdir is harmless
 * (nothing else looks for it), but we log on failure for visibility.
 */
function _cleanupOverlay(overlay) {
    if (!overlay)
        return;
    try {
        if (fs.existsSync(overlay)) {
            // rmSync with force=true removes symlinks too without following
            // them. recursive=true so the directory itself is removed.
            fs.rmSync(overlay, { recursive: true, force: true });
        }
    }
    catch (e) {
        console.warn(`[gryphon/codex-hooks] failed to remove overlay ${overlay}: ${e.message}`);
    }
}
/**
 * Adapter contract — see hook-dispatcher.js for the schema.
 */
function buildSpawnExtras({ pluginDir, ipcSocketPath, nodePath, storeGuardOnly, options }) {
    const projectDir = options && typeof options.projectDir === "string" ? options.projectDir : null;
    if (storeGuardOnly) {
        if (!nodePath || !storeGuardOnly.scriptPath || !storeGuardOnly.approvalsDir)
            return null;
        const overlay = _createCodexHomeOverlay({ nodePath, storeGuard: storeGuardOnly, projectDir });
        return {
            env: { CODEX_HOME: overlay, GRYPHON_HOOK_PROVIDER: KIND },
            args: [...CODEX_FORCE_HOOKS_ARGS], // R43-2: a vault config can't switch the guard off.
            cleanup: () => _cleanupOverlay(overlay),
            settingsFile: path.join(overlay, "config.toml"),
        };
    }
    if (!pluginDir || !ipcSocketPath || !nodePath) {
        // Dispatcher pre-flight should have caught these; defensive only.
        return null;
    }
    const overlay = _createCodexHomeOverlay({ pluginDir, nodePath, projectDir });
    return {
        env: {
            CODEX_HOME: overlay,
            GRYPHON_PERMISSION_SOCKET: ipcSocketPath,
            // Issue #33: identify this hook spawn's parent CLI to the plugin
            // so a protected deny here marks codex-cli (specifically) as
            // needing a fresh spawn next time, regardless of whether the
            // hook input's session_id matches what the provider tracks.
            GRYPHON_HOOK_PROVIDER: KIND,
        },
        args: [...CODEX_FORCE_HOOKS_ARGS], // hooks come from <CODEX_HOME>/config.toml; the flag only stops a vault switching them off (R43-2).
        cleanup: () => _cleanupOverlay(overlay),
        settingsFile: path.join(overlay, "config.toml"),
    };
}
/**
 * R3-1: a CODEX_HOME that carries only the project-trust entries — for a
 * spawn whose hooks couldn't be installed, so the vault's own Codex config
 * still doesn't apply. Throws when the folder can't be encoded safely.
 */
function buildTrustOnlyOverlay({ projectDir }) {
    const overlay = _createCodexHomeOverlay({ projectDir, trustOnly: true });
    return { env: { CODEX_HOME: overlay }, cleanup: () => _cleanupOverlay(overlay) };
}
module.exports = {
    kind: KIND,
    buildSpawnExtras,
    buildTrustOnlyOverlay,
    _projectTrustToml,
    _tomlString,
    // Internals exposed for tests:
    _buildHooksToml,
    _codexHookTrustHash,
    _renderTrustState,
    _buildStoreGuardToml,
    _buildModelInstructions,
    _createCodexHomeOverlay,
    _cleanupOverlay,
    PRESERVED_FROM_REAL_HOME,
};
