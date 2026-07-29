"use strict";
// TypeScript module marker.
Object.defineProperty(exports, "__esModule", { value: true });
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
const claudeCodeAdapter = require("./claude-code");
const codexCliAdapter = require("./codex-cli");
const geminiCliAdapter = require("./gemini-cli");
const antigravityCliAdapter = require("./antigravity-cli");
const REGISTRY = {
    [claudeCodeAdapter.kind]: claudeCodeAdapter,
    [codexCliAdapter.kind]: codexCliAdapter,
    [geminiCliAdapter.kind]: geminiCliAdapter,
    [antigravityCliAdapter.kind]: antigravityCliAdapter,
};
function getAdapter(kind) {
    return REGISTRY[kind] || null;
}
function listSupportedKinds() {
    return Object.keys(REGISTRY).sort();
}
module.exports = { getAdapter, listSupportedKinds };
