/**
 * Canonical model registry for Gryphon.
 *
 * Single source of truth for: pricing, aliases, context windows, cold-start
 * budgets, dropdown labels, vendor-specific subsets (e.g. Codex CLI's
 * ChatGPT-auth whitelist), and the legacy-alias migration table.
 *
 * The per-vendor pricing files (`pricing/openai.js`, `pricing/google.js`,
 * `pricing/anthropic.js`) and the plugin-shell tables (`MODELS`,
 * `MODEL_CONTEXT`, `COLD_START_BUDGET_MS`, `MODEL_ALIAS_MIGRATION`) all
 * derive from this registry. Adding a new model = editing this file only.
 *
 * **Probe discipline**: no model lands here without a successful probe
 * via `scripts/probe-model.sh <vendor> <id>`. The commit message must
 * include the probe verdict.
 */
export {};
