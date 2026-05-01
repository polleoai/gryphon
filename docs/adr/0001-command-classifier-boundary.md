# ADR 0001 — Command classifier module boundary

**Status:** Accepted
**Date:** 2026-04-23
**Context window:** v0.9 polish arc (pattern-hardening + audit)

## Context

The protected-pattern classifier (`src/providers/shared/attack-detector.js`
plus its pattern data in `src/constants.js`) is the single enforcement
point for Gryphon's guardrail feature — every Bash / PowerShell / Write /
Edit tool-call passes through it. It is plausibly the most re-usable
piece of the plugin: a second integration (a VSCode host, a standalone
CLI wrapper, another AI-agent plugin) would want the same engine and
the same curated rule set.

We considered extracting it into its own npm package (`@polleoai/
command-classifier` or similar) and consuming it as an external
dependency. We decided to **keep it in-tree for now** (Phase A), on the
grounds that:

1. No second consumer exists yet, so external packaging is speculative.
2. Publishing to npm introduces real supply-chain risk — a compromised
   publisher account would compromise every downstream consumer. That
   tax is acceptable when it's paid by a beneficiary, not when it's
   paid into the void.
3. Iteration is faster with the classifier in-tree while the rule set
   is still churning.

We also reserve the right to extract later (Phase B) when a concrete
downstream consumer appears. The purpose of this ADR is to record the
design constraints that make that future extraction cheap.

## Decision

The classifier is developed **as if** it were already an external
package, even though it lives in the Gryphon tree today. That means:

1. **No Obsidian imports.** Classifier code must not `require("obsidian")`,
   reference `Notice`, `setTooltip`, `MarkdownView`, DOM APIs, or any
   other host-specific surface. If host integration is needed, the
   host calls into the classifier with parameters; the classifier
   never calls into the host.

2. **No filesystem I/O from the classifier.** The classifier receives
   strings and returns classification objects. Reading files is the
   host's job.

3. **No direct access to `plugin.settings`.** Settings pass in as a
   parameter (the `ctx` object). The classifier does not reach back
   into the plugin instance to look things up.

4. **Constants travel with the classifier.** `DEFAULT_PROTECTED_PATHS`,
   `DEFAULT_PROTECTED_COMMANDS`, and `PROTECTED_CATEGORIES` are part
   of the classifier's public surface. UI code in the plugin imports
   from them; the classifier does not import from UI code.

5. **No Obsidian-specific error types.** Throw plain `Error` subclasses
   or return result objects. Host-specific error handling happens at
   the host boundary.

6. **Pure functions where possible.** `classify()` is pure. New
   helpers should stay pure unless there's a compelling reason.

7. **Normalization of untrusted input at the boundary.** The classifier
   runs `NFKC` normalization and zero-width-character stripping on
   every command string before matching. This closes naïve Unicode
   obfuscation (fullwidth `ｒｍ`, zero-width joiners) at essentially
   zero cost. Cyrillic homoglyphs (`рm`) remain a known limitation —
   defending them requires a confusables fold table, which is not
   justified by the threat profile.

## Decoupling detection set from reminder-trigger set

A secondary concern forced a related decision: the
`[gryphon-reminder]` anti-drift block injected into user prompts when
trigger keywords appear.

Previously, `_buildTriggerKeywords()` in `chat-view.js` auto-extracted
trigger keywords from `DEFAULT_PROTECTED_COMMANDS`. This created an
implicit coupling: **growing the detection rule set grew the reminder-
trigger rule set too**, which risks over-firing the reminder on
common English prose ("find me the notes", "install the plugin") when
new patterns add 3+ character tokens that collide with everyday words.

Decision: the two sets are decoupled by an **explicit exclusion list**
(`REMINDER_TRIGGER_EXCLUSIONS`) of tokens that appear in detection
patterns but must not become reminder triggers. The detection set can
grow freely; the trigger set grows only for tokens that are both
(a) distinctive enough not to hit common prose, AND (b) associated
with a refusal shape where the reminder's anti-drift value is real.

The exclusion list lives in `src/chat-view.js` alongside
`_buildTriggerKeywords`, documented with the English-collision reason
for each excluded token.

## Consequences

**Positive:**
- Extraction to an external package is a mechanical `git subtree split`
  when the time comes; no code changes needed.
- The classifier is testable in isolation (pure inputs, pure outputs).
- Adding new patterns has zero token cost at LLM runtime (patterns live
  in JS, matched locally after the model emits a tool call). The
  reminder-trigger decoupling preserves this property even as the
  detection set grows.

**Negative:**
- Contributors need to know the boundary exists. ADR + inline comments
  at each constraint site (classifier file, UI-ingestion sites) do
  this work.
- Some plugin-specific conveniences (reading settings directly, using
  Obsidian's `Notice` for diagnostics) are off-limits to classifier
  code. Workarounds are slightly more verbose.

**Neutral:**
- In-tree vs. out-of-tree is not visible to users — the classifier
  ships in the plugin bundle either way. This ADR is a maintainer-
  facing decision.

## Related work

- `src/providers/shared/attack-detector.js` — classifier entry point,
  must obey all constraints above.
- `src/constants.js` — pattern data, categories, defaults. Host-agnostic
  by nature.
- `src/chat-view.js` — contains `_buildTriggerKeywords` and the
  exclusion-list rationale.
- `docs/v0.5.0-attack-detector-design.md` — original design doc,
  superseded in boundary specifics by this ADR.
