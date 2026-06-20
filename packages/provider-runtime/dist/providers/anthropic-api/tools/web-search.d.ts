/**
 * WebSearch tool — search the web via Brave Search API.
 *
 * Anthropic's first-party web search isn't exposed through the API, so
 * Anthropic API mode integrates with a third-party provider. Brave is the default:
 *   - Has a generous free tier (2000 queries/month)
 *   - Privacy-focused (no tracking, no Google logins)
 *   - Simple REST API (one auth header, JSON response)
 *
 * The user supplies their own Brave API key via plugin settings; the
 * tool gracefully degrades to an instructive error when no key is set
 * (rather than failing silently or pretending to search).
 *
 * Permission: read-only network. Refused only in plan mode.
 */
export {};
