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
 * The hook scripts (hooks/pretool.js etc.) are already provider-
 * agnostic — they read JSON from stdin and write JSON to stdout, the
 * same wire format Claude Code, Codex, and Gemini all consume.
 */

const claudeCodeAdapter = require("./claude-code");
const codexCliAdapter = require("./codex-cli");
const geminiCliAdapter = require("./gemini-cli");

const REGISTRY = {
  [claudeCodeAdapter.kind]: claudeCodeAdapter,
  [codexCliAdapter.kind]: codexCliAdapter,
  [geminiCliAdapter.kind]: geminiCliAdapter,
};

function getAdapter(kind) {
  return REGISTRY[kind] || null;
}

function listSupportedKinds() {
  return Object.keys(REGISTRY).sort();
}

module.exports = { getAdapter, listSupportedKinds };
