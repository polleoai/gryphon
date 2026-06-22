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
declare function testApiKey(apiKey: any, hostAdapter: any): Promise<{
    ok: boolean;
    message: string;
}>;
export { testApiKey };
