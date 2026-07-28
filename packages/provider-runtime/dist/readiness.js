"use strict";
/**
 * Provider-readiness kernel (issue #16).
 *
 * The proactive companion to the #15 failover signal. #15 reports *after the
 * fact* which provider answered when a request fell back. But the witnessed
 * Athena scenario never fired a request at all (headless capture needs no
 * LLM), so no reactive signal could ever have warned the user that their
 * selected provider was inert. The only thing that catches that is a
 * *before-send* readiness judgement — "is the selected provider actually
 * usable, and if not, why".
 *
 * This module is the single source of truth for that judgement, host-agnostic
 * and PURE: settings/env presence + the same local binary detection the
 * factory already uses. NO network, NO API call. Both UI surfaces (Gryphon's
 * Settings status chip and the chat fallback attribution) — and any embedding
 * consumer's own surface (Athena's capture-page footer) — read from here so
 * the readiness verdict can never drift from `createProvider`'s real
 * selection logic.
 *
 * `describeProviderReadiness` is built on `getActiveProviderKind`, which
 * mirrors `createProvider` exactly; the not-ready reason mirrors chat-view's
 * `_refineConstructNullReason` rule (API kind with no key → "no-api-key";
 * CLI kind with no binary → "construct-null").
 */
Object.defineProperty(exports, "__esModule", { value: true });
const { getActiveProviderKind } = require("./factory");
const { DEFAULT_PROVIDER_PREFERENCE } = require("@gryphon/provider-config");
/**
 * Is the selected provider actually usable, and if not, why?
 *
 * @param plugin      host plugin (only `.settings` is read).
 * @param preference  override the judged preference; defaults to
 *                    `plugin.settings.providerPreference`. Lets a consumer ask
 *                    "would *this* kind be ready?" without mutating settings.
 * @returns { ready, reason, kind }
 *   - ready true  → `kind` is the resolved provider (same one createProvider
 *                   would build); `reason` null.
 *   - ready false → `kind` null; `reason` names why (no-api-key | construct-null).
 *
 * Pure presence check — no network. A present-but-invalid key still reads as
 * ready here (we can't know it's bad without a call); that case is caught
 * reactively by #15's failover `auth` classification.
 */
function describeProviderReadiness(plugin, preference) {
    const settings = (plugin && plugin.settings) || {};
    const pref = preference || settings.providerPreference || DEFAULT_PROVIDER_PREFERENCE;
    // Built on getActiveProviderKind so the verdict can never diverge from
    // createProvider's selection. When the caller overrides the preference, probe
    // with a shallow settings clone carrying that preference — never mutate the
    // host's settings.
    const probe = pref === (settings.providerPreference || DEFAULT_PROVIDER_PREFERENCE)
        ? plugin
        : { ...plugin, settings: { ...settings, providerPreference: pref } };
    const kind = getActiveProviderKind(probe);
    if (kind)
        return { ready: true, reason: null, kind };
    return { ready: false, reason: _readinessReason(pref, settings), kind: null };
}
/**
 * Why is `pref` not ready? Mirrors chat-view._refineConstructNullReason: an
 * API kind with no key reads as "no-api-key"; a CLI kind with no binary (and
 * "auto" with nothing resolvable) reads as the generic "construct-null".
 */
function _readinessReason(pref, settings) {
    if (pref === "anthropic-api")
        return (settings.anthropicApiKey || process.env.ANTHROPIC_API_KEY) ? "construct-null" : "no-api-key";
    if (pref === "openai-api")
        return (settings.openaiApiKey || process.env.OPENAI_API_KEY) ? "construct-null" : "no-api-key";
    if (pref === "google-api")
        return (settings.googleApiKey || process.env.GOOGLE_API_KEY) ? "construct-null" : "no-api-key";
    // claude-code / codex-cli / gemini-cli: construct-null = missing binary.
    // "auto": nothing resolvable. Neither is a key problem.
    return "construct-null";
}
/**
 * Humanize a failure/readiness reason to the user-facing shape (issue #16).
 * Shared by the Settings chip and the chat fallback attribution so both
 * surfaces speak identically.
 */
function humanizeFailureReason(reason) {
    switch (reason) {
        case "no-api-key": return "no API key";
        case "auth": return "invalid API key";
        case "insufficient-credit": return "out of credit";
        case "quota": return "quota exceeded";
        case "rate-limit": return "rate-limited";
        case "construct-null": return "not found";
        default: return "unavailable";
    }
}
/**
 * Human-friendly label for a provider kind (issue #16). Promoted from
 * chat-view's local `_providerLabelFor` map so both surfaces share one
 * mapping; chat-view's becomes a thin delegate.
 */
function friendlyProviderLabel(kind) {
    switch (kind) {
        case "anthropic-api": return "Anthropic API";
        case "claude-code": return "Claude Code CLI";
        case "openai-api": return "OpenAI API";
        case "google-api": return "Google Gemini API";
        case "codex-cli": return "Codex CLI";
        case "gemini-cli": return "Gemini CLI";
        case "antigravity-cli": return "Antigravity CLI";
        default: return kind || "the provider";
    }
}
module.exports = {
    describeProviderReadiness,
    humanizeFailureReason,
    friendlyProviderLabel,
};
