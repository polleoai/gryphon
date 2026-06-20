"use strict";
/**
 * Google Gemini API key validator.
 *
 * Stage 3 (#18) lands the full GoogleProvider; until then this standalone
 * module backs the "Test key" button in Settings so users can verify their
 * key works before Stage 3 ships. When the full provider lands, that file
 * should re-export `testApiKey` from here (or absorb the logic) so the
 * Settings tab's import path stays stable.
 *
 * Validation path: GET /v1beta/models?key=<KEY>. This is the cheapest
 * Gemini API call — no model invocation, no token consumption, just an
 * auth check that returns the list of available models if the key is good.
 *
 * Network access is routed through the `hostAdapter` parameter
 * (Task 0.4). Callers in Obsidian will pass ObsidianHostAdapter (Task 0.6);
 * callers that omit it get HeadlessHostAdapter as a default so old call
 * sites don't crash before Task 0.6 lands.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const GEMINI_LIST_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models";
async function testApiKey(apiKey, hostAdapter) {
    // Default to HeadlessHostAdapter so callers that pre-date Task 0.6 still
    // work (they pass undefined). Task 0.6 will supply ObsidianHostAdapter.
    if (!hostAdapter) {
        hostAdapter = new (require("../../host-adapter").HeadlessHostAdapter)();
    }
    if (!apiKey)
        return { ok: false, message: "No API key provided" };
    try {
        // hostAdapter.fetch with throw:false — ObsidianHostAdapter passes it
        // through to requestUrl; HeadlessHostAdapter ignores unknown opts and
        // uses globalThis.fetch (which may throw on non-2xx depending on
        // configuration — the try/catch below catches that).
        const res = await hostAdapter.fetch(`${GEMINI_LIST_MODELS_URL}?key=${encodeURIComponent(apiKey)}`, { method: "GET", throw: false });
        if (res.status === 200) {
            return { ok: true, message: "Key works" };
        }
        if (res.status === 400 || res.status === 401 || res.status === 403) {
            // Google returns 400 with API_KEY_INVALID for malformed keys, 403 for
            // unauthorized / disabled keys. Either way it's a key problem.
            return { ok: false, message: "Invalid API key" };
        }
        if (res.status === 429) {
            return { ok: false, message: "Rate limited (key may be valid; try again later)" };
        }
        // Try to surface Google's structured error message when present.
        const errMsg = res.json && res.json.error && res.json.error.message;
        return {
            ok: false,
            message: errMsg
                ? `API error (${res.status}): ${errMsg}`
                : `API error (${res.status})`,
        };
    }
    catch (err) {
        // Network-level failure (DNS, TLS, offline). Not a key issue per se,
        // but the user can't proceed regardless — surface the underlying message.
        return { ok: false, message: String((err && err.message) || err) };
    }
}
module.exports = { testApiKey };
