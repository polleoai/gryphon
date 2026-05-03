# ADR 0003 — First non-Anthropic providers (OpenAI + Google via SDK)

**Status:** Proposed (pending implementation in v1.2.0)
**Date:** 2026-05-01
**Context window:** First user request for non-Anthropic providers, two days after v1.1.4 public release.
**Supersedes (in part):** ADR 0002's "no second provider yet" stance — the breadth-abstraction veto from 0002 is preserved unchanged.

## Context

ADR 0002 (2026-05-01, accepted same day this is proposed) established that Gryphon adds a new LLM provider only when concrete user demand for that specific provider materializes, via a hand-built adapter under `src/providers/<name>/`. The reserved escape hatches in 0002 named Gemini and OpenAI as the most likely candidates.

Two days after v1.1.4 shipped, the user requested OpenAI and Google integration. Both candidates simultaneously — exactly the reserved escape hatch.

This ADR scopes that integration:
- Which Gryphon-side surface the integration uses (SDK direct-HTTP vs CLI-wrap).
- Which security guarantees apply, and which honestly do not.
- Why the breadth-abstraction veto from 0002 still stands despite adding two providers in one release.

### Surfaces both vendors expose

Each of the three major coding-agent vendors offers two integration surfaces:

| Vendor   | SDK (HTTP client)                       | Agent CLI (subprocess wrapper target)                 |
|----------|-----------------------------------------|-------------------------------------------------------|
| Anthropic | `@anthropic-ai/sdk` — used by `anthropic-api/` | `claude` CLI — wrapped by `claude-code/` with full hook surface (27 events, 5 categories) |
| OpenAI    | `openai` npm package — direct HTTP, streaming, tool calls | OpenAI Codex CLI — has hooks (~3–13 events including PreToolUse, PostToolUse, PermissionRequest, Stop) |
| Google    | `@google/genai` — direct HTTP, streaming, function calling | Gemini CLI — recently added hooks (early 2026, covers PreToolUse, Action Completion, Session Boundaries) |

Both Codex CLI and Gemini CLI grew real hook surfaces during 2025–early 2026. The earlier ADR 0002 framing ("only Claude Code has hooks") was correct as of late 2025 but is no longer accurate. ADR 0003 corrects the record.

### Two integration shapes

**Shape A — SDK direct-HTTP** (mirrors `anthropic-api/`):
- Gryphon owns the tool loop end-to-end.
- Every tool call passes through `permission-gate.js` (Axis 1: modes; Axis 2: protected patterns).
- Every tool result passes through `attack-detector.js` (synthetic equivalent of `PostToolUse` injection scan).
- No subprocess. No external binary required. User brings an API key.

**Shape B — Agent CLI wrap** (mirrors `claude-code/`):
- Gryphon spawns the vendor's agent CLI as a subprocess.
- The agent runs the tool loop; Gryphon intercepts via the agent's hook events.
- Subscription billing path possible (user's existing OpenAI/Google CLI auth).
- Requires binary discovery (`utils.js::findClaudeBinary` analog for `codex` and `gemini`).
- Hook surface coverage varies — Codex covers the security-critical four (`PreToolUse` + `PostToolUse` + `PermissionRequest` + `Stop`); Gemini's hooks are newer and partial.

## Decision

**v1.2.0 ships Shape A for both OpenAI and Google.** Two new SDK adapters under `src/providers/openai-api/` and `src/providers/google-api/`, each conforming to the LLMProvider contract from `provider-interface.js` and reusing the shared `attack-detector` / `provenance-store` / `permission-ipc-server` / `untrusted-framing` modules.

**Shape B (`codex-cli` mode + `gemini-cli` mode) is roadmap, not v1.2.** Targeted for v1.3 or v1.4 once two preconditions are met:
1. The vendor's hook surface has soaked enough in production to gate on (Gemini's is too young as of 2026-05-01).
2. We have explicit user demand for subscription-billing parity with `claude-code` mode for those vendors.

**The breadth-abstraction veto from ADR 0002 stands unchanged.** No LiteLLM, no Vercel AI SDK as router, no OpenRouter. Four hand-built adapters now (claude-code + anthropic-api + openai-api + google-api), with two more (codex-cli + gemini-cli) on the roadmap. The escape-hatch language in ADR 0002 anticipated exactly this trajectory.

## Why SDK first, not CLI wrap

The corrected hook-parity picture (Codex and Gemini both expose real hook surfaces) means Shape B is no longer "strictly weaker protection." It would be **comparable protection with smaller event coverage**. So the SDK-first reasoning has to stand on something other than "CLI wrap is unsafe." Three reasons it does:

### 1. Hook maturity is the soft spot, and Shape B inherits it

Gemini CLI hooks landed in early 2026 — that's roughly v0.1 of a production-security-gating API. Gryphon spent v1.0.x → v1.1.4 fixing bugs around Claude Code's hook reliability (Windows shell quoting, single-quoted paths, edge-case event ordering). Wrapping a younger hook surface means inheriting another round of those bugs before users see value. Shape A avoids that class of problem entirely because Gryphon owns the tool loop in-process.

### 2. Binary discovery + auth handoff is its own engineering burden

`utils.js::findClaudeBinary` solves CLI discovery for Flatpak Obsidian, $PATH detection, manual override. Doing it again for `codex` and `gemini` binaries doubles that work — for two binaries that aren't yet as universally installed in our user base as `claude` is.

### 3. Direct-HTTP shipping pattern is proven for Gryphon

`anthropic-api/` mode was added before `claude-code/` mode in Gryphon's history. SDK-first → CLI-wrap-second is the tested integration ordering for adding a vendor to Gryphon. Inverting it for OpenAI/Google would be untested.

## Security claim scoping

The two-axis security model (per `feedback_two_axis_security_design` and the marketing copy) applies to all four v1.2 modes:

| Mode | Axis 1 (permission modes) | Axis 2 (protected patterns) | Extra: hook layer |
|------|---------------------------|------------------------------|-------------------|
| `claude-code`    | ✓ | ✓ | ✓ — 27-event Claude Code hook surface |
| `anthropic-api`  | ✓ | ✓ | — (synthetic equivalents in tool-loop) |
| `openai-api`     | ✓ | ✓ | — (synthetic equivalents in tool-loop) |
| `google-api`     | ✓ | ✓ | — (synthetic equivalents in tool-loop) |

`supportsHooks` per ADR 0002's primitive:
- `claude-code` → `"native"`
- `anthropic-api` / `openai-api` / `google-api` → `"synthetic"`
- (future) `codex-cli` → `"native"` with documented event-coverage gaps relative to claude-code
- (future) `gemini-cli` → `"native"` with larger documented event-coverage gaps

The marketing claim **"two-axis security across all providers"** is honest and load-bearing for v1.2. The narrower claim **"the Claude Code mode adds an additional hook-based defense layer specific to that CLI's mature hook surface"** stays in the documentation but is not a prerequisite for using OpenAI or Google — those modes deliver the same two-axis protection `anthropic-api` does today.

## Constraints any new SDK provider must respect (extends ADR 0002 constraints)

A v1.2 provider lands under `src/providers/<name>/` and:

1. **Implements the LLMProvider contract.** Constructor + `send` + `abort` + `isAlive`. Sets `sessionId`, `resolvedModel`, `contextTokens`. Calls `onMessage` / `onError` / `onDone` per documented type tags.

2. **Routes every tool call through `providers/shared/permission-ipc-server.js`** (the modes-axis + patterns-axis gate) before execution.

3. **Routes every tool result through `providers/shared/attack-detector.js`** (synthetic `PostToolUse` injection scan) before re-ingestion into the model context.

4. **Translates Gryphon's tool registry to the vendor's tool-call format** at the adapter boundary, not inside shared code:
   - OpenAI: `tools[].function.parameters` (JSON Schema).
   - Google: `function_declarations[].parameters` (JSON Schema, slight dialect differences).

5. **Declares `supportsHooks: "synthetic"`** so the settings UI surfaces the protection level honestly (no claim that PreToolUse / PostToolUse fire as separate processes — they're synthetic, in-loop equivalents).

6. **Provides a per-model USD price table.** New tables under `src/providers/<name>/pricing.js`, mirroring how Anthropic pricing is captured today. Cost telemetry is unified at the chat-view layer; the price book is data, not code.

7. **Inherits the shared 95% auto-compact threshold** computed against the vendor's native context-window size.

8. **Uses the vendor's official Node SDK** (`openai` and `@google/genai`). Hand-rolled HTTP allowed but discouraged.

9. **Conforms to the no-internal-refs test** (`tests/no-internal-refs.test.js`).

10. **Adds provider-specific tests** under `tests/<name>-*.test.js`. At minimum: streaming event normalization, tool-call shape translation, error path, abort path, attack-detector against a representative tool-call shape from this vendor.

## Reserved escape hatches (v1.3+)

This ADR explicitly reserves but does not commit to:

- **`codex-cli` mode** — wraps the OpenAI Codex CLI binary, registers Gryphon as an MCP server, hooks into `PreToolUse` + `PostToolUse` + `PermissionRequest` + `Stop`. Documented event-coverage gaps relative to `claude-code` (no `UserPromptSubmit`, no `Notification` rate-limit hook). Subscription-billing parity for ChatGPT Plus / Pro users.

- **`gemini-cli` mode** — wraps the Gemini CLI binary. Hook coverage smaller still (covers `PreToolUse`, "Action Completion", session boundaries); some Gryphon protections become Claude-Code-mode-only refinements documented as such in settings UI.

- **Local-model providers via Ollama** — separate decision, not blocked by this ADR but not committed by it either. Re-opens questions ADR 0002's "neutral" section listed (offline-first variant).

Each escape hatch above gets its own successor ADR (0004, 0005, ...) when its trigger conditions are met. They do NOT pre-authorize "open the floodgates."

## Consequences

**Positive:**
- Two new providers land in v1.2 with the same two-axis security guarantee `anthropic-api` already provides.
- ~600–1000 lines of new provider code (adapter + tool-loop + tool-format translation + tests per provider). No new shared infrastructure required.
- Marketing copy can honestly say "OpenAI and Google supported" without weakening the security story.
- The `supportsHooks` declaration primitive from ADR 0002 gets exercised for the first time, validating its design.

**Negative:**
- Doubles the per-release security audit surface. `attack-detector.js` patterns are calibrated against Claude's output style; need re-validation against GPT-4o / GPT-5 and Gemini-2.x output styles. Coverage debt grows linearly per ADR 0002's argument — accepted because this is two specific providers, not a generic abstraction.
- Tool-call format translation is per-vendor maintenance. OpenAI and Google occasionally tweak schema; we'll absorb those.
- Cost telemetry now needs three provider-specific price tables that drift independently of each other.

**Neutral:**
- Factory's "auto" tiebreaker stays Claude-first; OpenAI and Google modes are explicit-choice. ADR 0002's "auto preference ordering may need to change" speculation does not fire for v1.2.
- `provider-interface.js` contract turned out to be sufficient — no breaking changes needed to add OpenAI or Google. Validates the contract design.

## Implementation reference

- Design spec: `docs/v1.2.0-openai-google-providers-design.md` (sibling document; defines file inventory, factory diff, settings additions, tool-format translation tables, test plan delta, release strategy 1.2-both-vs-1.2/1.3-split criteria).
- Implementation plan: `docs/v1.2.0-openai-google-providers-plan.md` (tasks, ordering, milestones, QA gates).

## Related work

- ADR 0002 — provider integration strategy (the breadth-abstraction veto this ADR preserves).
- `src/providers/provider-interface.js` — the LLMProvider contract OpenAI and Google adapters implement.
- `src/providers/anthropic-api/` — reference implementation; OpenAI and Google adapters mirror its shape.
- `src/providers/shared/permission-ipc-server.js`, `attack-detector.js`, `provenance-store.js`, `injection-patterns.js`, `untrusted-framing.js` — shared infrastructure reused as-is.
- ADR 0001 — command classifier boundary (host-agnostic constraint that makes the classifier work across providers).

## When to supersede

A successor ADR replaces this one if any of:

1. A v1.3+ CLI-wrap mode (`codex-cli` or `gemini-cli`) ships — successor scopes that integration's hook coverage and security claim.
2. A breadth abstraction (LiteLLM / Vercel AI SDK / OpenRouter) becomes credible — successor reverses ADR 0002's veto with current data, then this ADR's per-provider scope folds into the broader strategy.
3. A vendor's tool-call format diverges enough that the per-adapter translation pattern becomes untenable — successor proposes a normalized intermediate format owned by Gryphon.

Until one of those happens, this ADR is the answer for OpenAI and Google integration scope.
