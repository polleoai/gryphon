# @gryphon/provider-runtime

LLM provider runtime for Gryphon. Spawn / stream / abort / retry across six providers.

## Providers

- **Claude Code** (subprocess) — wraps the `claude` CLI with stream-json I/O
- **Anthropic API** (HTTP SDK) — direct `@anthropic-ai/sdk`, with tool loop
- **OpenAI API** (HTTP SDK) — direct `openai` SDK, with tool loop
- **Google Gemini API** (HTTP SDK) — direct `@google/genai` SDK, with tool loop
- **Codex CLI** (subprocess) — OpenAI Codex one-shot wrapper
- **Gemini CLI** (subprocess) — Google Gemini one-shot wrapper

## Public API

```js
const {
  createProvider,
  explainUnavailable,
  detectAvailable,
  getActiveProviderKind,
} = require("@gryphon/provider-runtime");

const provider = createProvider(plugin, cwd, options);
provider.onMessage = (text, type) => { ... };
const result = await provider.send("Hello");
```

A `protectionContext` (from `@gryphon/protect`) can be injected via options for protected spawn semantics. Pass `null` for unprotected mode.

## Boundary

This package depends on `@gryphon/protect` (when present) and `@gryphon/provider-config` (for pricing tables and per-provider known-flag tables). It does not know about Obsidian — it can run in any Node host.
