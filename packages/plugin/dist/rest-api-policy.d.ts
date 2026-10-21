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
declare const OBSIDIAN_REST_API_DEFAULT_PORT = 27124;
declare const LOOPBACK_HOSTNAMES: Set<string>;
/**
 * Recognize a URL targeting the obsidian-local-rest-api plugin.
 *
 * Matches the default port (27124) on any loopback hostname. The
 * default REST plugin uses 27124 for HTTPS and 27123 for HTTP; we
 * match both — the LLM has been seen using either.
 *
 * @param {string} url
 * @returns {boolean}
 */
declare function isObsidianRestApiUrl(url: unknown): boolean;
/**
 * User-facing reason string for a deny. Speaks plain English about the
 * cost-multiplier the policy exists to prevent, and points the model at
 * the recovery path (vault-native search or `kb`-style tooling).
 */
declare function buildRestApiDenyReason(): string;
/**
 * Per-turn GET counter. The plugin owns one instance; `note(url)` is
 * called on every classified WebFetch that hit a REST API URL with the
 * policy in "allowed" mode. When the count crosses `threshold`, the
 * onWarn callback fires exactly once per turn — the user gets a single
 * toast no matter how many additional GETs follow.
 *
 * `reset()` is called on every user send (so each new turn starts at
 * zero) and on /new / /clear.
 */
declare class RestApiTurnCounter {
    threshold: number;
    onWarn: ((count: number) => void) | null;
    count: number;
    _warned: boolean;
    constructor({ threshold, onWarn }?: {
        threshold?: number;
        onWarn?: ((count: number) => void) | null;
    });
    note(): number;
    reset(): void;
}
export { OBSIDIAN_REST_API_DEFAULT_PORT, LOOPBACK_HOSTNAMES, isObsidianRestApiUrl, buildRestApiDenyReason, RestApiTurnCounter, };
