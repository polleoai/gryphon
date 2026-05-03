# ADR 0002 — Provider integration strategy

**Status:** Accepted
**Date:** 2026-05-01
**Context window:** v1.1 post-launch — first follow-up question after shipping the v1.1.x feature pass

## Context

Gryphon currently supports two LLM providers:

- **`claude-code/`** — subprocess wrapper around the Claude Code CLI, gated by the standalone hook scripts (`PreToolUse`, `PostToolUse`, `SessionStart`, `UserPromptSubmit`, `Notification`, `SessionEnd`) that Claude Code spawns via `--settings`.
- **`anthropic-api/`** — direct HTTP via `@anthropic-ai/sdk`, with the protected-pattern classifier intercepting tool calls in our own tool-loop.

The factory in `src/providers/factory.js` selects between them; the LLMProvider contract in `src/providers/provider-interface.js` documents the shape every provider must implement (constructor + `send` + `abort` + `isAlive` + `sessionId` / `resolvedModel` / `contextTokens` properties + `onMessage` / `onError` / `onDone` callbacks).

Question raised post-launch: *"Should we adopt LiteLLM (or similar) so users get access to GPT, Gemini, Mistral, Cohere, local models via Ollama, etc., without us hand-writing an adapter per SDK?"*

The concern behind the question is real: hand-writing N provider adapters from scratch doesn't scale, and contributors who ask for "support model X" shouldn't have to wait for a multi-week port.

We considered four options:

1. **LiteLLM (Python).** A unified interface to 100+ providers. Mature, actively maintained, free.
2. **Vercel AI SDK (`ai` npm package).** Node-native equivalent — one streaming/tool-call interface across OpenAI, Anthropic, Google, Mistral, Cohere, Groq, Bedrock, Azure, and ~25 others through provider plugins.
3. **OpenRouter as a single endpoint.** One HTTP API, hundreds of models, users bring an OpenRouter key.
4. **Hand-built adapter per provider** under `src/providers/<name>/`, conforming to the existing LLMProvider contract.

## Decision

**Stay with option 4: hand-built adapter per provider, formalized through the existing `provider-interface.js` contract.** Add a new provider only when concrete user demand for that specific provider materializes. Do NOT adopt LiteLLM, Vercel AI SDK, or OpenRouter as a generic breadth strategy.

The decision is grounded in five constraints that none of the breadth options satisfy together:

### 1. The hook surface is Claude-specific

Gryphon's two-axis security model promises that protected-pattern enforcement runs **before** the model emits a tool call (in the SDK path) and **at the runtime boundary** (via Claude Code hooks in the CLI path). That promise is the product. It only translates to providers that:

- Surface tool calls before execution (most do for the SDK path — fine).
- Have a hook-equivalent runtime mechanism for the CLI path (only Claude Code does today).

Adding LiteLLM or Vercel AI SDK gives us "many providers" but it does NOT give us "many providers, all gated by our hooks." Shipping non-Claude providers as fully-gated would be a security claim we can't keep. Shipping them as ungated would mean some Gryphon sessions get the two-axis protection and others don't — without that distinction being obvious to the user. Both options weaken the security story Gryphon was built around.

### 2. Bundle / runtime constraints

Gryphon ships as a single Obsidian plugin bundle (`main.js`, currently ~370 KB, Node + browser context). Constraints:

- **LiteLLM is Python.** Adopting it means either (a) requiring Python as a runtime dependency for end users, which most Obsidian users don't have, or (b) running the LiteLLM proxy as a separate service the user must host, contradicting the "in your vault, no external service" framing. Both options are non-trivial to support on macOS / Windows / Linux. Past Windows-CLI work showed how brittle that surface is.
- **Vercel AI SDK is Node-native** and fits the runtime, but adds 60–150 KB for core + 2–3 provider plugins, and forces us to maintain compatibility with their abstraction's quirks across version bumps.
- **OpenRouter** routes user data through a third party. For a security-positioned plugin, that's a real privacy claim the user has to accept — appropriate to offer as an explicit opt-in, not as the default path.

### 3. Test surface non-linearity

We're at 562 tests, much of which exercises injection-pattern detection, attack-detector behavior, and the two-provider tool-loop integration. Adding a generic abstraction layer means: N different streaming response formats to normalize, N different tool-call shapes, N different error modes, N different rate-limit behaviors. Injection patterns and attack-detector rules are calibrated against Claude's typical output style; they'd need re-validation against every provider's output. That's not a one-time cost — it's permanent coverage debt that grows linearly with provider count.

A hand-built adapter per provider keeps this cost linear AND attributable: each provider's tests own its own assertions.

### 4. Positioning and product story

Gryphon's pitch is "Claude in your Obsidian vault, with security as a separate axis" — the messenger + protector framing. Going wide ("100 LLMs in your vault") puts Gryphon into the crowded list-the-providers fight that ~12 existing Obsidian AI plugins are already losing. Depth (security model + hook integration + in-Obsidian UX matching CC's terminal UX) is the wedge. Breadth is the wrong axis to compete on right now.

### 5. The interface already exists

`src/providers/provider-interface.js` and `src/providers/factory.js` already document the contract every provider must implement. Both existing providers conform to it. A new provider isn't a multi-week port — it's a `~300–500 line` file that fills in the contract using whatever provider SDK is most appropriate. We have leverage already; we don't need to import an external abstraction to get it.

## Constraints any new provider must respect

A new provider lands under `src/providers/<name>/` and:

1. **Implements the LLMProvider contract.** Constructor + `send` + `abort` + `isAlive`. Sets `sessionId`, `resolvedModel`, `contextTokens`. Calls `onMessage` / `onError` / `onDone` per the documented type tags (`"init"`, `"replace"`, `"tool"`).

2. **Routes tool calls through `providers/shared/attack-detector.js`** before execution if the provider supports tool use. Non-Claude tool-call shapes must be normalized into the classifier's expected input shape at the adapter boundary, not inside the classifier. This preserves the "no Obsidian / no host imports" constraint from ADR 0001.

3. **Uses the provider's own Node SDK** wherever one exists. Building HTTP calls by hand is allowed but discouraged — SDKs already handle SSE, retries, auth, and rate limit signals in ways that are tedious to redo correctly.

4. **Documents hook compatibility honestly.** The provider declares `supportsHooks: "native" | "synthetic" | "none"`. Settings UI surfaces this so users see which protections apply. A `"synthetic"` declaration means the adapter implements equivalents of `PreToolUse` / `PostToolUse` inside the tool loop (no separate hook process); `"none"` means hook scripts don't fire and the user is told.

5. **Conforms to the no-internal-refs test** (`tests/no-internal-refs.test.js`). No leaks of dev-side identifiers, sibling-project paths, or scrubbed tokens.

6. **Adds provider-specific tests** under `tests/<name>-*.test.js`. At minimum: streaming event normalization, tool-call shape, error path, abort path, the attack-detector on a representative tool-call shape from this provider.

7. **Updates the factory** (`src/providers/factory.js`) and the settings tab (`src/plugin.js`) to allow user selection. The factory's "auto" tiebreaker stays Claude-first (Claude Code → Anthropic API → other) because the security guarantee is strongest there.

## Reserved escape hatches

This ADR does not foreclose option 2 or 3 forever. Two scenarios where we'd revisit:

- **Specific second-provider demand from real users.** If GitHub issues or Discord show consistent demand for Gemini / GPT-5 / a local-model via Ollama, write a hand-built adapter for that one provider. The decision point is per-provider, not "open the floodgates."

- **Strategic shift in the LLM landscape.** If Anthropic deprecates a model class, or if a local-model story becomes table-stakes for security-conscious users (e.g., an offline-first Gryphon variant), the breadth-via-abstraction question gets re-opened with current data. At that point Vercel AI SDK is the prime candidate — Node-native, MIT-licensed, fits the bundle. LiteLLM stays off the table unless Python becomes acceptable as a runtime requirement for some reason that doesn't exist today.

If/when that happens, this ADR is superseded by a new one rather than amended. Don't let the "we're keeping it open" clause turn into a slow drift toward LiteLLM-by-default.

## Consequences

**Positive:**
- Security model stays load-bearing across every supported provider (or honestly degraded with clear UI signaling).
- Bundle stays Node-only, single-file, no external service required.
- Test surface grows linearly with provider count, not as a quadratic cross-product of (provider × abstraction-quirk).
- Each provider's adapter is 300–500 lines and fully understood by us; debugging doesn't require reading a third party's abstraction.
- The provider-interface contract is already paid for — formalizing it doesn't cost us; ignoring it would.

**Negative:**
- Adding a third provider is a real piece of work (~1–2 weeks for adapter + tests + UI surfacing + docs). We don't get the "10 providers overnight" feeling LiteLLM advertises.
- We can't claim "supports any LLM" in marketing copy. That's fine — it isn't Gryphon's wedge.
- Contributors who'd love to PR a generic LiteLLM integration will be told no. ADR + this file's "Reserved escape hatches" section give them the answer without us having to retype it.

**Neutral:**
- The existing `provider-interface.js` documents the contract but doesn't enforce it (JS is duck-typed). Formalization via TypeScript types is a future option, not a requirement of this ADR.
- The factory's "auto" Claude-first preference ordering may need to change if/when a non-Claude provider lands. That's a small follow-up at integration time.

## Related work

- `src/providers/provider-interface.js` — documents the contract every provider implements.
- `src/providers/factory.js` — selects between configured providers, surfaces setup guidance when none are available.
- `src/providers/anthropic-api/anthropic-api.js`, `tool-loop.js` — reference implementation #1.
- `src/providers/claude-code/claude-code.js` — reference implementation #2 (with hook surface).
- `src/providers/shared/attack-detector.js` — the classifier every provider's tool path routes through.
- `docs/adr/0001-command-classifier-boundary.md` — the host-agnostic constraint that makes the classifier provider-agnostic too.

## When to supersede

A successor ADR replaces this one if any of:

1. A second provider ships and the contract turns out to be insufficient — successor documents the contract change.
2. Specific market data justifies adopting Vercel AI SDK for a defined subset of providers — successor scopes which providers go through the abstraction and how the security claim is reframed for them.
3. A consumer outside Gryphon needs the provider abstraction (in which case we'd extract `provider-interface.js` plus its tests as an npm package, similar to the Phase B path described in ADR 0001 for the classifier).

Until one of those happens, this ADR is the answer.
