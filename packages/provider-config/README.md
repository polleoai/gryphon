# @gryphon/provider-config

Provider configuration for Gryphon — the cc-switch-shaped layer.

## What it does

- **Pricing tables + model dropdown options** for OpenAI and Google providers (cost per token, context window, default model, dropdown grouping).
- **Per-provider extra-args filter** — known-flag tables that prevent (e.g.) Claude-only `--allowedTools` from leaking onto Codex spawns.

This package is **pure data + selection logic**. No process spawning, no HTTP, no UI.

## Public API

```js
const { pricing, filterExtraArgs } = require("@gryphon/provider-config");

const opts = pricing.openai.getModelDropdownOptions();
const cost = pricing.openai.computeCost({ model, usage });

const { filtered, dropped } = filterExtraArgs(args, "claude-code");
```

## Boundary

No dependencies on protection or runtime. Both layers depend on this; this layer depends on neither.

The eventual roadmap includes consolidating `getActiveProviderKind`, `detectAvailable`, and `explainUnavailable` (currently in `@gryphon/provider-runtime/src/factory.js`) into this package as part of a `resolveConfig({ settings })` pure function — that's a follow-up refactor, not yet shipped.
