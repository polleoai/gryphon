/**
 * F4 (v1.7.0) — Obsidian REST API access policy.
 *
 * The `obsidian-local-rest-api` community plugin exposes the vault as a
 * REST API on loopback (https://127.0.0.1:27124 by default). When a
 * panel LLM running in claude-code mode has WebFetch enabled and the
 * REST plugin is installed, it can — and in witnessed cases will —
 * naively enumerate the entire vault to "find page X", issuing hundreds
 * of GETs before answering a question a single grep would have closed
 * in milliseconds.
 *
 * Two behaviours live here:
 *
 *   1. `isObsidianRestApiUrl(url)` — host/port matcher used by the
 *      classify path to recognize REST plugin traffic regardless of
 *      whether the LLM hit 127.0.0.1, localhost, ::1, etc.
 *
 *   2. `RestApiTurnCounter` — per-session GET counter that fires a
 *      one-time callback when a threshold is crossed within a single
 *      turn. Reset on every user send.
 *
 * SDK providers (anthropic-api / openai-api / google-api) already
 * refuse loopback WebFetch via SSRF defense in
 * `provider-runtime/.../tools/web-fetch.js`, so policy enforcement is
 * specific to claude-code mode (CC's built-in WebFetch reaches
 * loopback freely).
 */
export {};
