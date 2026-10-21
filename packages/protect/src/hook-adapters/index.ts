// TypeScript module marker.

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

import * as claudeCode from "./claude-code";
import * as codexCli from "./codex-cli";
import * as geminiCli from "./gemini-cli";
import * as antigravityCli from "./antigravity-cli";

// One plain object per adapter, copied from its module. The dispatcher (and
// every other caller) reaches an adapter only through getAdapter(), so this
// object is the single replaceable seam: a test substitutes buildSpawnExtras /
// lastRefusal here. (An ES module's own exports are read-only bindings.)
const REGISTRY: Record<string, unknown> = {
  [claudeCode.kind]: { ...claudeCode },
  [codexCli.kind]: { ...codexCli },
  [geminiCli.kind]: { ...geminiCli },
  [antigravityCli.kind]: { ...antigravityCli },
};

function getAdapter(kind: string) {
  return REGISTRY[kind] || null;
}

function listSupportedKinds() {
  return Object.keys(REGISTRY).sort();
}

export { getAdapter, listSupportedKinds };
