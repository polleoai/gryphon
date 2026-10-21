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
exports.getAdapter = getAdapter;
exports.listSupportedKinds = listSupportedKinds;
/**
 * Hook-adapter registry for the HookDispatcher.
 *
 * Each adapter knows how to translate Gryphon's canonical hook-config
 * object (the provider-agnostic intermediate representation) into
 * provider-specific spawn artifacts (env vars, CLI args, cleanup
 * function). The dispatcher selects the adapter by `kind` at spawn
 * time.
 *
 * Adding a new provider means writing one adapter file:
 *   1. Create `<kind>.js` in this directory exporting:
 *        { kind, buildSpawnExtras({ hookConfig, ipcSocketPath, pluginDir, nodePath }) }
 *   2. Register it below.
 *
 * The hook scripts (hooks/pretool.js etc.) read JSON from stdin and write
 * JSON to stdout — the same wire format Claude Code, Codex, and Gemini all
 * consume. Antigravity is the exception: it sends a camelCase, nested
 * `toolCall` payload and expects a flat `{decision, reason}` reply, so its
 * translation lives in `hooks/dialects.ts` and is selected at runtime via
 * the `GRYPHON_HOOK_DIALECT` env var the adapter sets.
 */
const claudeCode = __importStar(require("./claude-code"));
const codexCli = __importStar(require("./codex-cli"));
const geminiCli = __importStar(require("./gemini-cli"));
const antigravityCli = __importStar(require("./antigravity-cli"));
// One plain object per adapter, copied from its module. The dispatcher (and
// every other caller) reaches an adapter only through getAdapter(), so this
// object is the single replaceable seam: a test substitutes buildSpawnExtras /
// lastRefusal here. (An ES module's own exports are read-only bindings.)
const REGISTRY = {
    [claudeCode.kind]: { ...claudeCode },
    [codexCli.kind]: { ...codexCli },
    [geminiCli.kind]: { ...geminiCli },
    [antigravityCli.kind]: { ...antigravityCli },
};
function getAdapter(kind) {
    return REGISTRY[kind] || null;
}
function listSupportedKinds() {
    return Object.keys(REGISTRY).sort();
}
