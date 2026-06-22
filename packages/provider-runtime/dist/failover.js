"use strict";
/**
 * Failure classification kernel (issue #15).
 *
 * `classifyProviderFailure` is the wire-shape-agnostic classifier that the
 * failover orchestrator (chat-view) AND headless/vendoring consumers (Athena
 * drives the provider layer from its synthesis/page-production path too) use
 * to decide whether a failure is an *availability* failure worth retrying on
 * a fallback provider — versus a genuine content/runtime error that must NOT
 * trigger failover (re-attempting would discard partial good output and burn
 * a provider the user didn't pick).
 *
 * It is pure over its single argument — NO chat-view, factory, or settings
 * dependency — so synthesis.js can import it standalone. It subsumes and
 * replaces chat-view's local `_isRateLimitError` (now a thin delegate) so
 * there is one source of truth for "is this a transient/availability error."
 *
 * The six providers surface availability failures three different ways:
 *   - SDKs (anthropic/openai/google): typed errors carrying an HTTP `status`
 *     (or `statusCode`, or nested `error.status`) plus a message.
 *   - CLIs (claude-code/codex-cli/gemini-cli): the failure is stderr text /
 *     an exit code surfaced as a plain Error message.
 * So we classify on HTTP status + message regex, never on `instanceof` of an
 * SDK-specific class (the three SDKs use different error classes, and the
 * CLIs throw none).
 */
Object.defineProperty(exports, "__esModule", { value: true });
const { CliStructuredOutputError } = require("./cli-structured-output");
// Order of these checks is load-bearing (see classifyProviderFailure).
//
// no-api-key: the key was never supplied. SDKs that defer the check throw
// these at send-time; construct-time is handled by the `null` branch.
const NO_API_KEY_RE = /could not resolve authentication|environment variable is missing|api[\s_-]?key[^.]{0,40}\b(?:not set|is missing|missing|is required|must be set|not provided|not configured|is empty)\b|\b(?:no|missing)\s+api[\s_-]?key\b/i;
// auth: a key exists but is invalid / expired / forbidden.
const AUTH_RE = /invalid[\s_-]?(?:x-)?api[\s_-]?key|api key not valid|invalid_api_key|authentication[\s_-]?(?:error|failed)|unauthorized|permission[\s_-]?denied|forbidden|expired/i;
// insufficient-credit / billing. Checked BEFORE rate-limit because OpenAI
// surfaces an out-of-credit account as HTTP 429 + code "insufficient_quota"
// — that is a billing failure, not a transient throttle.
const INSUFFICIENT_RE = /insufficient[\s_-]?(?:quota|credit|funds|balance)|insufficient_quota|billing|credit balance is too low|exceeded your current quota|check your plan|payment required|out of (?:credit|funds)|balance is too low/i;
// rate-limit: a transient throttle.
const RATE_LIMIT_RE = /\b429\b|too many requests|rate[\s\-_]?limit(?:ed)?|resource_exhausted|usage limit reached|[Pp]lease retry in/i;
// quota: daily / free-tier exhaustion (distinct from a billing shortfall).
const QUOTA_RE = /quota[\s_]?(?:exceeded|exhausted)/i;
// content: the provider worked but produced unusable output (schema
// validation, content filter). These must NOT fail over.
const CONTENT_RE = /no parseable json|did not match schema|schema validation|content[\s_-]?filter|response was blocked|safety/i;
function _statusOf(err) {
    if (!err)
        return null;
    return (err.status ||
        err.statusCode ||
        (err.error && err.error.status) ||
        (err.response && err.response.status) ||
        null);
}
function _avail(reason) {
    return { kind: "availability", reason };
}
/**
 * Classify a provider failure.
 *
 * @param errOrNull  the thrown error, OR `null`/`undefined` to signal a
 *                   construct-time failure (createProvider returned null).
 * @returns { kind, reason }
 *   - kind "availability" → safe to retry on a fallback. `reason` names why.
 *   - kind "content" / "runtime" → do NOT fail over. `reason` is null.
 */
function classifyProviderFailure(errOrNull) {
    // Construct-time: createProvider returned null (no key / no CLI). This
    // always fails *before* any assistant content streams, so it is always a
    // safe-to-retry availability failure.
    if (errOrNull == null)
        return _avail("construct-null");
    const status = _statusOf(errOrNull);
    const msg = String((errOrNull && errOrNull.message) || errOrNull || "");
    // Priority order matters: message-specific overrides are checked ahead of
    // raw status so OpenAI's insufficient_quota-as-429 lands on billing, and a
    // "key not set" never reads as a generic auth failure.
    if (NO_API_KEY_RE.test(msg))
        return _avail("no-api-key");
    if (status === 401 || status === 403 || AUTH_RE.test(msg))
        return _avail("auth");
    if (status === 402 || INSUFFICIENT_RE.test(msg))
        return _avail("insufficient-credit");
    if (status === 429 || RATE_LIMIT_RE.test(msg))
        return _avail("rate-limit");
    if (QUOTA_RE.test(msg))
        return _avail("quota");
    // Everything else: a working provider that errored. Distinguish content
    // (bad output) from runtime (network/timeout/5xx/unknown) for the reported
    // signal; neither triggers failover.
    if (errOrNull instanceof CliStructuredOutputError || CONTENT_RE.test(msg)) {
        return { kind: "content", reason: null };
    }
    return { kind: "runtime", reason: null };
}
module.exports = { classifyProviderFailure };
