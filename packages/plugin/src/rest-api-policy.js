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

const OBSIDIAN_REST_API_DEFAULT_PORT = 27124;

const LOOPBACK_HOSTNAMES = new Set([
  "127.0.0.1",
  "localhost",
  "::1",
  "[::1]",
  "0.0.0.0",
]);

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
function isObsidianRestApiUrl(url) {
  if (typeof url !== "string" || !url) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const host = (parsed.hostname || "").toLowerCase();
  if (!LOOPBACK_HOSTNAMES.has(host)) return false;
  // Default REST plugin ports: 27124 (HTTPS), 27123 (HTTP). The plugin
  // is configurable but the defaults catch ~all real installs.
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  return port === "27124" || port === "27123";
}

/**
 * User-facing reason string for a deny. Speaks plain English about the
 * cost-multiplier the policy exists to prevent, and points the model at
 * the recovery path (vault-native search or `kb`-style tooling).
 */
function buildRestApiDenyReason() {
  return (
    "Gryphon blocked this WebFetch to the Obsidian REST API. " +
    "Enumerating the vault one URL at a time costs hundreds of tool " +
    "calls per question; use vault-native search (Grep / glob / a " +
    "custom CLI) instead, or ask the user to enable REST API access " +
    "for this session via the toolbar chip in the Gryphon panel."
  );
}

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
class RestApiTurnCounter {
  constructor({ threshold = 50, onWarn = null } = {}) {
    this.threshold = threshold;
    this.onWarn = onWarn;
    this.count = 0;
    this._warned = false;
  }

  note() {
    this.count += 1;
    if (!this._warned && this.count >= this.threshold) {
      this._warned = true;
      if (typeof this.onWarn === "function") {
        try {
          this.onWarn(this.count);
        } catch (e) {
          // Don't break the classify path, but don't lose the signal
          // either — this warning is exactly what the counter exists
          // to deliver. A console line surfaces the regression to the
          // developer while the classify response still flows.
          try {
            console.error("[gryphon] rest-api onWarn callback threw:", e);
          } catch { /* truly desperate — keep going */ }
        }
      }
    }
    return this.count;
  }

  reset() {
    this.count = 0;
    this._warned = false;
  }
}

module.exports = {
  OBSIDIAN_REST_API_DEFAULT_PORT,
  LOOPBACK_HOSTNAMES,
  isObsidianRestApiUrl,
  buildRestApiDenyReason,
  RestApiTurnCounter,
};
