"use strict";
// TypeScript module marker.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.GEMINI_HOOK_EVENTS = exports.kind = void 0;
exports.buildSpawnExtras = buildSpawnExtras;
exports._buildHooksJson = _buildHooksJson;
exports._buildStoreGuardJson = _buildStoreGuardJson;
exports._buildModelInstructions = _buildModelInstructions;
exports._writeSettingsFile = _writeSettingsFile;
exports._cleanupFile = _cleanupFile;
/**
 * Gemini CLI hook adapter.
 *
 * Gemini CLI's hook system uses the same JSON-over-stdin contract
 * Claude Code pioneered, but with two surface differences:
 *
 *   1. Event names are Gemini-flavored:
 *        Claude/Codex            Gemini
 *        ─────────────           ──────
 *        PreToolUse              BeforeTool
 *        PostToolUse             AfterTool
 *        UserPromptSubmit        BeforeAgent  (closest analog)
 *        SessionStart            SessionStart   (same)
 *        SessionEnd              SessionEnd     (same)
 *        Notification            Notification   (same)
 *
 *   2. Output schema is flat with different field names:
 *        Claude/Codex: { hookSpecificOutput: { hookEventName,
 *                          permissionDecision, permissionDecisionReason } }
 *        Gemini:       { decision, reason, systemMessage }
 *
 *      We handle (2) by passing GRYPHON_HOOK_DIALECT=gemini in the
 *      spawn env — the shared hook scripts (hooks/pretool.js etc.)
 *      check that var and emit the right shape. Input field names
 *      are the SAME across all three CLIs (`tool_name`, `tool_input`,
 *      `session_id`, `hook_event_name`), so no input adapter is
 *      needed.
 *
 * Spawn-time wiring: write a tmp settings.json containing the hook
 * registrations and point Gemini at it via
 * `GEMINI_CLI_SYSTEM_SETTINGS_PATH=<file>`. This keeps Gryphon's
 * hook config out of the user's real ~/.gemini/settings.json so:
 *
 *   - A crashed Gryphon never leaves config behind that affects the
 *     user's interactive `gemini` use.
 *   - Two vaults running Gryphon don't stomp on each other.
 *   - The plugin owns the lifecycle: spawn creates, close deletes.
 */
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const crypto = __importStar(require("crypto"));
const hook_settings_builder_1 = require("@polleoai/gryphon-provider-runtime/providers/claude-code/hook-settings-builder");
const system_prompt_hints_1 = require("../system-prompt-hints");
const store_guard_command_1 = require("./store-guard-command");
const shell_quote_1 = require("@polleoai/gryphon-provider-runtime/shell-quote");
const KIND = "gemini-cli";
exports.kind = KIND;
/**
 * R43-4: a vault's own .gemini/settings.json (Gemini's workspace layer) can
 * switch hooks off — `hooksConfig.enabled: false`, or `hooksConfig.disabled`
 * (merged across layers by UNION) naming a hook. Gemini matches `disabled`
 * against the hook's `name` (or its command when unnamed), so Gryphon's hook
 * names carry a per-spawn random suffix a vault can't know in advance, and
 * Gryphon's system-settings layer (which ranks above the workspace layer)
 * sets `hooksConfig.enabled: true`.
 */
function _hookNameNonce() {
    return crypto.randomBytes(6).toString("hex");
}
/**
 * Issue #30: store-guard-only settings — a single BeforeTool hook. Gemini's
 * `timeout` is MILLISECONDS (see _buildHooksJson).
 */
function _buildStoreGuardJson({ nodePath, storeGuard, nonce = _hookNameNonce() }) {
    const cmd = (0, store_guard_command_1.storeGuardCommand)({ nodePath, scriptPath: storeGuard.scriptPath, approvalsDir: storeGuard.approvalsDir, dialect: "gemini" });
    const hook = {
        name: `gryphon-store-guard-${nonce}`,
        type: "command",
        command: cmd.command,
        timeout: store_guard_command_1.STORE_GUARD_TIMEOUT_S * 1000,
    };
    if (cmd.shell)
        hook.shell = cmd.shell;
    return { hooksConfig: { enabled: true }, hooks: { BeforeTool: [{ matcher: "*", hooks: [hook] }] } };
}
/**
 * Mapping from Gryphon's canonical hook events (Claude-Code-named)
 * to Gemini's event names + the matcher to use. Order matches the
 * claude-code/codex builders so behavior parity is easy to audit.
 */
const GEMINI_HOOK_EVENTS = [
    // [geminiEventName, hookFileName, matcher, timeoutKey]
    ["BeforeTool", hook_settings_builder_1.HOOK_FILES.PreToolUse, "", "PreToolUse"],
    ["AfterTool", hook_settings_builder_1.HOOK_FILES.PostToolUse, hook_settings_builder_1.POSTTOOL_MATCHER, "PostToolUse"],
    ["SessionStart", hook_settings_builder_1.HOOK_FILES.SessionStart, "", "SessionStart"],
    ["SessionEnd", hook_settings_builder_1.HOOK_FILES.SessionEnd, "", "SessionEnd"],
    // BeforeAgent is the closest Gemini analog to UserPromptSubmit —
    // fires before the agent processes a user message. The hook script
    // is the same `user-prompt.js` we ship for Claude Code.
    ["BeforeAgent", hook_settings_builder_1.HOOK_FILES.UserPromptSubmit, "", "UserPromptSubmit"],
    ["Notification", hook_settings_builder_1.HOOK_FILES.Notification, "", "Notification"],
];
exports.GEMINI_HOOK_EVENTS = GEMINI_HOOK_EVENTS;
/**
 * Build the canonical hook-config JSON object Gemini reads from
 * settings.json. Mirrors the JSON shape `buildHookSettings` returns
 * for claude-code, just with different event names per the table
 * above and Gemini's per-hook `name` field (used in error logs).
 */
function _buildHooksJson({ pluginDir, nodePath, nonce = _hookNameNonce() }) {
    const hooksDir = path.join(pluginDir, "hooks");
    const isWindows = process.platform === "win32";
    const makeCommand = (scriptName) => {
        const scriptPath = path.join(hooksDir, scriptName);
        // R43-1: real shell quoting (the script path is under the vault folder).
        if (isWindows) {
            return {
                command: (0, shell_quote_1.hookCommandLine)(nodePath, scriptPath, "win32"),
                shell: "powershell",
            };
        }
        return {
            command: (0, shell_quote_1.hookCommandLine)(nodePath, scriptPath),
        };
    };
    const hooksBlock = {};
    for (const [geminiEvent, scriptName, matcher, timeoutKey] of GEMINI_HOOK_EVENTS) {
        const cmd = makeCommand(scriptName);
        const hookEntry = {
            name: `gryphon-${geminiEvent.toLowerCase()}-${nonce}`,
            type: "command",
            command: cmd.command,
            // CRITICAL: Gemini interprets `timeout` in MILLISECONDS, while
            // Claude Code and Codex CLI both treat it as SECONDS. Our
            // DEFAULT_HOOK_TIMEOUTS table is in seconds (`PreToolUse: 300`
            // = 5 minutes), so multiply by 1000 here. Without this, the
            // hook timed out in 300 ms — far less than the user's
            // think-time on the approve/deny modal — and Gemini fell
            // through to default-allow. The rm ran, the model saw a
            // generic failure, and surfaced "file does not exist" to the
            // user. Reported by user 2026-05-03.
            timeout: hook_settings_builder_1.DEFAULT_HOOK_TIMEOUTS[timeoutKey] * 1000,
        };
        if (cmd.shell)
            hookEntry.shell = cmd.shell;
        hooksBlock[geminiEvent] = [{
                // Gemini's matcher syntax: empty string means "match all" (same
                // as Claude Code). Specific patterns are tool-name regex.
                matcher: matcher || "*",
                hooks: [hookEntry],
            }];
    }
    return { hooksConfig: { enabled: true }, hooks: hooksBlock };
}
/**
 * Render the model-instructions content. Same source as Codex's
 * adapter — the directives are provider-agnostic.
 */
function _buildModelInstructions() {
    const bullets = system_prompt_hints_1.GRYPHON_SYSTEM_PROMPT_HINT.split("· ").map((s) => s.trim()).filter(Boolean);
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
        system_prompt_hints_1.GRYPHON_FALLBACK_DENY_HINT.replace(/^· /, ""),
        "",
    ].join("\n");
}
function _writeSettingsFile(settings) {
    const rand = crypto.randomBytes(4).toString("hex");
    const name = `gryphon-gemini-settings-${process.pid}-${Date.now()}-${rand}.json`;
    const fullPath = path.join(os.tmpdir(), name);
    fs.writeFileSync(fullPath, JSON.stringify(settings, null, 2), {
        flag: "wx",
        mode: 0o600,
    });
    return fullPath;
}
function _writeModelInstructionsFile() {
    const rand = crypto.randomBytes(4).toString("hex");
    const name = `gryphon-gemini-instructions-${process.pid}-${Date.now()}-${rand}.md`;
    const fullPath = path.join(os.tmpdir(), name);
    fs.writeFileSync(fullPath, _buildModelInstructions(), {
        flag: "wx",
        mode: 0o600,
    });
    return fullPath;
}
function _cleanupFile(file) {
    if (!file)
        return;
    try {
        if (fs.existsSync(file))
            fs.unlinkSync(file);
    }
    catch (e) {
        console.warn(`[gryphon/gemini-hooks] failed to remove ${file}: ${e.message}`);
    }
}
/**
 * Adapter contract — see hook-dispatcher.js for the schema.
 *
 * Returns env vars + cleanup. No CLI args are added (Gemini reads
 * the settings file from the env-var-pointed path automatically).
 *
 * Env vars set:
 *   - GEMINI_CLI_SYSTEM_SETTINGS_PATH — points at our hooks
 *     settings.json
 *   - GRYPHON_PERMISSION_SOCKET — IPC socket path the hook scripts
 *     dial back to
 *   - GRYPHON_HOOK_DIALECT=gemini — tells the shared hook scripts
 *     to emit Gemini's `{decision, reason}` output shape instead of
 *     Claude Code's `{hookSpecificOutput: {permissionDecision, ...}}`
 */
function buildSpawnExtras({ pluginDir, ipcSocketPath, nodePath, storeGuardOnly }) {
    if (storeGuardOnly) {
        if (!nodePath || !storeGuardOnly.scriptPath || !storeGuardOnly.approvalsDir)
            return null;
        const file = _writeSettingsFile(_buildStoreGuardJson({ nodePath, storeGuard: storeGuardOnly }));
        return {
            env: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: file, GRYPHON_HOOK_PROVIDER: KIND },
            args: [],
            cleanup: () => _cleanupFile(file),
            settingsFile: file,
        };
    }
    if (!pluginDir || !ipcSocketPath || !nodePath) {
        return null;
    }
    const settings = _buildHooksJson({ pluginDir, nodePath });
    const settingsFile = _writeSettingsFile(settings);
    // QA-V13H-A: if the second write throws after the first succeeded,
    // the first file would leak in tmpdir (no cleanup function reaches
    // the caller because `buildSpawnExtras` itself rejects). Roll back
    // the first write so this adapter is idempotent under partial-
    // failure: either both files exist and `cleanup` removes them, or
    // neither file exists.
    let instructionsFile;
    try {
        instructionsFile = _writeModelInstructionsFile();
    }
    catch (e) {
        _cleanupFile(settingsFile);
        throw e;
    }
    const cleanup = () => {
        _cleanupFile(settingsFile);
        _cleanupFile(instructionsFile);
    };
    return {
        env: {
            GEMINI_CLI_SYSTEM_SETTINGS_PATH: settingsFile,
            GRYPHON_PERMISSION_SOCKET: ipcSocketPath,
            GRYPHON_HOOK_DIALECT: "gemini",
            // Issue #33: identify this hook spawn's parent CLI to the plugin
            // (parallel to codex-cli + claude-code adapters). On a protected
            // deny, the plugin marks gemini-cli for force-fresh next spawn,
            // regardless of session_id matching.
            GRYPHON_HOOK_PROVIDER: KIND,
            // GEMINI_SYSTEM_MD points Gemini at a markdown file to use as
            // additional model instructions (parallel to Codex's
            // model_instructions_file). Without this, the model
            // paraphrases our deny reason instead of quoting it verbatim
            // and may improvise about the "mechanism" — leaking
            // "BeforeTool hook" / "intercept" vocabulary the user
            // shouldn't see. The directives include the COMPOUND REQUESTS
            // rule (do safe sub-tasks, then quote the deny reason) and
            // the no-leak vocabulary list. Same shared source as Claude
            // Code's --append-system-prompt and Codex's
            // model_instructions_file.
            GEMINI_SYSTEM_MD: instructionsFile,
        },
        args: [],
        cleanup,
        settingsFile,
        instructionsFile,
    };
}
