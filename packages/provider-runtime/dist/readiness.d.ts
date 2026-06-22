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
export {};
