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
export {};
