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
exports.kind = void 0;
exports.buildSpawnExtras = buildSpawnExtras;
/**
 * Claude Code hook adapter.
 *
 * Wraps Gryphon's existing claude-code/hook-settings-builder.js. The
 * actual hook-config JSON shape lives there (it's what Claude Code's
 * `--settings` flag consumes). This adapter just plugs that builder
 * into the HookDispatcher's contract.
 */
const fs = __importStar(require("fs"));
const hook_settings_builder_1 = require("@polleoai/gryphon-provider-runtime/providers/claude-code/hook-settings-builder");
const KIND = "claude-code";
exports.kind = KIND;
/**
 * Translate a canonical-ish hook-config request into Claude Code spawn
 * extras.
 *
 * @param {object} args
 * @param {string} args.pluginDir       — absolute path to the Gryphon plugin
 * @param {string} args.ipcSocketPath   — absolute path to the IPC socket
 * @param {string} args.nodePath        — absolute path to a real node binary
 * @param {object} [args.permissionsOnly] — fallback config (deny-list only)
 *                                           passed when hook installation
 *                                           failed pre-flight; adapter writes
 *                                           a permissions-only settings file
 *                                           so basic enforcement survives.
 * @returns {{ env, args, cleanup, settingsFile }}
 */
function buildSpawnExtras({ pluginDir, ipcSocketPath, nodePath, permissionsOnly }) {
    let settingsFile = null;
    let extraEnv = {};
    if (permissionsOnly) {
        // Fallback path — write a permissions.deny-only settings file. No
        // hooks block, no IPC env needed.
        const settings = (0, hook_settings_builder_1.buildPermissionsOnlySettings)(permissionsOnly.denyGlobs);
        settingsFile = (0, hook_settings_builder_1.writeHookSettingsFile)(settings);
    }
    else {
        const settings = (0, hook_settings_builder_1.buildHookSettings)({
            pluginDir,
            socketPath: ipcSocketPath,
            nodePath,
        });
        settingsFile = (0, hook_settings_builder_1.writeHookSettingsFile)(settings);
        extraEnv.GRYPHON_PERMISSION_SOCKET = ipcSocketPath;
        // Issue #33: identify this hook spawn's parent CLI to the plugin
        // (parallel to codex-cli + gemini-cli adapters). On a protected
        // deny, the plugin marks claude-code for force-fresh next spawn,
        // robust to session_id mismatches between the hook input and
        // the provider's stored sessionId.
        extraEnv.GRYPHON_HOOK_PROVIDER = KIND;
    }
    const cleanup = () => {
        if (!settingsFile)
            return;
        try {
            if (fs.existsSync(settingsFile))
                fs.unlinkSync(settingsFile);
        }
        catch (e) {
            console.warn(`[gryphon/hook-adapter] failed to remove ${settingsFile}: ${e.message}`);
        }
        settingsFile = null;
    };
    return {
        env: extraEnv,
        args: ["--settings", settingsFile],
        cleanup,
        settingsFile, // exposed for diagnostics (see existing claude-code debug logging)
    };
}
