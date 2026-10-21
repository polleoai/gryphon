/**
 * Provider-readiness kernel (issue #16).
 *
 * The proactive companion to the #15 failover signal. #15 reports *after the
 * fact* which provider answered when a request fell back. But the witnessed
 * embedding-plugin scenario never fired a request at all (headless capture needs no
 * LLM), so no reactive signal could ever have warned the user that their
 * selected provider was inert. The only thing that catches that is a
 * *before-send* readiness judgement — "is the selected provider actually
 * usable, and if not, why".
 *
 * This module is the single source of truth for that judgement, host-agnostic
 * and PURE: settings/env presence + the same local binary detection the
 * factory already uses. NO network, NO API call. Both UI surfaces (Gryphon's
 * Settings status chip and the chat fallback attribution) — and any embedding
 * consumer's own surface (e.g. a capture-page footer) — read from here so
 * the readiness verdict can never drift from `createProvider`'s real
 * selection logic.
 *
 * `describeProviderReadiness` is built on `getActiveProviderKind`, which
 * mirrors `createProvider` exactly; the not-ready reason mirrors chat-view's
 * `_refineConstructNullReason` rule (API kind with no key → "no-api-key";
 * CLI kind with no binary → "construct-null").
 */
import type { ProviderKind } from "./types";
type ReadinessReason = "no-api-key" | "construct-null" | null;
/** The settings fields readiness reads (host settings carry many more). */
interface ReadinessSettings {
    providerPreference?: string;
    anthropicApiKey?: string;
    openaiApiKey?: string;
    googleApiKey?: string;
}
interface ProviderReadiness {
    ready: boolean;
    reason: ReadinessReason;
    kind: ProviderKind | null;
}
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
declare function describeProviderReadiness(plugin: {
    settings?: ReadinessSettings;
} | null | undefined, preference?: string): ProviderReadiness;
/**
 * Humanize a failure/readiness reason to the user-facing shape (issue #16).
 * Shared by the Settings chip and the chat fallback attribution so both
 * surfaces speak identically.
 */
declare function humanizeFailureReason(reason: string | null): string;
/**
 * Human-friendly label for a provider kind (issue #16). Promoted from
 * chat-view's local `_providerLabelFor` map so both surfaces share one
 * mapping; chat-view's becomes a thin delegate.
 */
declare function friendlyProviderLabel(kind: string): string;
export { describeProviderReadiness, humanizeFailureReason, friendlyProviderLabel, };
