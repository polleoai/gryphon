/**
 * _separateCanonicalBlocks tests.
 *
 * The normalizer runs in chat-view's "replace" stream event handler,
 * applied to every onMessage(text) regardless of which provider
 * produced it. Locks in the smush-fixing behaviour so future provider
 * additions inherit the same paragraph-break guarantee for free.
 */

const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");

// Stub obsidian so chat-view.js can be required under node:test —
// same pattern used by chat-history-save-filter.test.js etc.
const stubPath = require.resolve("./_stubs/obsidian.js");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "obsidian") return stubPath;
  return originalResolve.call(this, request, ...args);
};

const { _separateCanonicalBlocks, _dedupeConsecutiveParagraphs, _collapseSummaryDrafts } = require("../src/chat-view");

// ---------- _collapseSummaryDrafts ----------
//
// Wraps earlier draft paragraphs in a <details> disclosure when the
// model regenerates a refused-turn answer. Only fires when a
// canonical deny marker is present in the text.

test("draft-fold: collapses two similar long summaries before a deny block", () => {
  const draft = "The axios npm package experienced a critical supply chain compromise where malicious versions were published via a compromised maintainer account, leading to platform-specific payload execution.";
  const final = "The current file details a critical supply-chain compromise of the axios npm package, where malicious versions 1.14.1 and 0.30.4 were published by a compromised maintainer account, leading to the installation of a backdoored plain-crypto-js dependency that executes platform-specific stage-2 payloads.";
  const deny = "This operation matches one of your protected patterns in Gryphon (destructive operation).";
  const input = `${draft}\n\n${final}\n\n${deny}`;
  const out = _collapseSummaryDrafts(input);
  assert.ok(out.includes("<details"), "must wrap drafts in a <details> disclosure");
  assert.ok(out.includes("Earlier draft"), "summary label must be 'Earlier draft' for a single draft");
  assert.ok(out.includes(draft), "the draft text must remain inside the details element");
  assert.ok(out.includes(final), "the final/refined paragraph must remain visible");
  assert.ok(out.includes(deny), "the deny block must remain visible");
});

test("draft-fold: 'Earlier drafts' (plural) when more than one draft", () => {
  const d1 = "Long enough draft one paragraph about a critical supply-chain compromise that needs to be summarised.";
  const d2 = "Long enough draft two paragraph about the same critical supply-chain compromise expanded with additional detail.";
  const final = "Long enough final paragraph about the same critical supply-chain compromise with the most refined wording for delivery.";
  const deny = "This operation matches one of your protected patterns in Gryphon.";
  const input = `${d1}\n\n${d2}\n\n${final}\n\n${deny}`;
  const out = _collapseSummaryDrafts(input);
  assert.ok(out.includes("Earlier drafts"), "label must pluralize for >=2 drafts");
});

test("draft-fold: does NOT fire when no canonical deny marker is present", () => {
  // Two similar paragraphs but no refusal. Could be legitimate
  // multi-paragraph response — leave it alone.
  const p1 = "The axios npm package experienced a critical supply chain compromise where malicious versions were published.";
  const p2 = "The current file details a critical supply-chain compromise of the axios npm package, expanded with additional detail.";
  const input = `${p1}\n\n${p2}`;
  const out = _collapseSummaryDrafts(input);
  assert.strictEqual(out, input, "without a deny marker, multi-paragraph content must pass through unchanged");
});

test("draft-fold: does NOT fire when paragraphs are too short to be summaries", () => {
  // Paragraphs under 80 chars — likely bullets/headings, not drafts.
  const p1 = "Short note about something.";
  const p2 = "Another short note about something.";
  const deny = "This operation matches one of your protected patterns in Gryphon.";
  const input = `${p1}\n\n${p2}\n\n${deny}`;
  const out = _collapseSummaryDrafts(input);
  assert.ok(!out.includes("<details"), "short paragraphs (<80 chars) must not be folded as drafts");
});

test("draft-fold: does NOT collapse paragraphs with low topic similarity", () => {
  // Two unrelated paragraphs (low Jaccard) — both ≥80 chars but no
  // shared vocabulary. Should not be merged as drafts.
  const p1 = "JavaScript developers should be cautious about supply-chain attacks targeting popular npm packages this quarter.";
  const p2 = "The kitten sat upon the mat, surveying its tiny kingdom with an air of well-deserved feline disdain.";
  const deny = "This operation matches one of your protected patterns in Gryphon.";
  const input = `${p1}\n\n${p2}\n\n${deny}`;
  const out = _collapseSummaryDrafts(input);
  assert.ok(!out.includes("<details"), "low-similarity paragraphs must not be folded together");
});

test("draft-fold: leaves a single substantive paragraph + deny untouched", () => {
  const p = "The axios npm package experienced a critical supply chain compromise where malicious versions were published.";
  const deny = "This operation matches one of your protected patterns in Gryphon.";
  const input = `${p}\n\n${deny}`;
  const out = _collapseSummaryDrafts(input);
  assert.strictEqual(out, input, "single paragraph + deny must pass through unchanged");
});

test("dedupe: collapses two identical non-trivial paragraphs back-to-back", () => {
  const para = "A critical supply-chain compromise of the axios npm package occurred when a maintainer account was compromised.";
  const input = `${para}\n\n${para}\n\nThis operation matches one of your protected patterns in Gryphon.`;
  const out = _dedupeConsecutiveParagraphs(input);
  // Should keep ONE copy of the duplicated summary plus the deny.
  const occurrences = out.split(para).length - 1;
  assert.strictEqual(occurrences, 1, "duplicate paragraph must be collapsed to a single occurrence");
  assert.ok(out.includes("This operation matches"));
});

test("dedupe: leaves DIFFERENT paragraphs alone", () => {
  const input = "First paragraph with substantive content here.\n\nSecond paragraph saying something else entirely.";
  const out = _dedupeConsecutiveParagraphs(input);
  assert.strictEqual(out, input, "different paragraphs must not be merged");
});

test("dedupe: does not collapse short identical paragraphs (avoids merging headings, bullets)", () => {
  // 4-char paragraphs are common in headings / bullets — don't dedupe.
  const input = "Yes\n\nYes\n\nNo";
  const out = _dedupeConsecutiveParagraphs(input);
  assert.strictEqual(out, input);
});

test("dedupe: empty / single-paragraph passes through", () => {
  assert.strictEqual(_dedupeConsecutiveParagraphs(""), "");
  assert.strictEqual(_dedupeConsecutiveParagraphs("just one paragraph"), "just one paragraph");
});

test("dedupe: collapses the exact user-reported axios-summary duplicate (Windows Gemini CLI 2.5 flash 2026-05-04)", () => {
  // Lock in the EXACT shape the user reported so future regressions
  // surface in CI. Two identical sentences on adjacent lines (single
  // \n between), then \n\n, then the canonical deny block.
  const summary = "The gist-axios-supply-chain-compromise.md file details a critical supply-chain attack on the axios npm package, where compromised versions (1.14.1 and 0.30.4) were distributed, leading to the execution of malicious payloads on affected systems.";
  const deny = "This operation matches one of your protected patterns in Gryphon (destructive operation).\n\nTo allow it:\n\nOpen Obsidian → Settings → Gryphon → Protected commands\nUncheck the matching pattern\nAsk me again";
  const input = `${summary}\n${summary}\n\n${deny}`;
  const out = _dedupeConsecutiveParagraphs(input);
  const occurrences = out.split(summary).length - 1;
  assert.strictEqual(occurrences, 1, "exact user-reported duplicate must collapse to one");
  assert.ok(out.includes("This operation matches"));
  assert.ok(out.includes("(destructive operation)"));
});

test("dedupe: collapses zero-separator duplicates (period directly butts next sentence)", () => {
  // Gemini CLI 2.5 flash on Windows occasionally emits two complete
  // sentences with NO whitespace between — "S1.S1." pattern. The
  // first-pass regex must accept zero-or-more whitespace, not just
  // one-or-more newlines. User report 2026-05-04.
  const sentence = "This manual describes Gryphon, an Obsidian chat plugin that connects to Claude, enabling users to edit vault files, run shell commands, and search the web, with detailed sections on setup.";
  const input = `${sentence}${sentence}`;
  const out = _dedupeConsecutiveParagraphs(input);
  const occurrences = out.split(sentence).length - 1;
  assert.strictEqual(occurrences, 1, "zero-separator duplicate must collapse to one");
});

test("dedupe: collapses CRLF-separated duplicates (Windows line endings)", () => {
  // Gemini CLI on Windows emits \r\n in its stream-json output. The
  // dedupe must normalize line endings before regex matching;
  // otherwise the \r-prefixed second occurrence isn't byte-equal to
  // the first capture and the dedupe misses. User report 2026-05-04
  // (Windows Gemini CLI 2.5 flash).
  const sentence = "The gist-axios-supply-chain-compromise.md file details a critical supply-chain attack on the axios npm package.";
  const input = `${sentence}\r\n${sentence}\r\n\r\nThis operation matches one of your protected patterns in Gryphon (destructive operation).`;
  const out = _dedupeConsecutiveParagraphs(input);
  const occurrences = out.split(sentence).length - 1;
  assert.strictEqual(occurrences, 1, "CRLF-separated duplicate must collapse to one");
  assert.ok(out.includes("This operation matches"));
});

test("dedupe: collapses CRLF blank-line-separated duplicates", () => {
  // Different shape — full \r\n\r\n between identical paragraphs.
  // The paragraph splitter must accept this as a paragraph boundary.
  const para = "A long enough paragraph that easily exceeds the forty character threshold for substantive content.";
  const input = `${para}\r\n\r\n${para}\r\n\r\nThis operation matches one of your protected patterns in Gryphon.`;
  const out = _dedupeConsecutiveParagraphs(input);
  const occurrences = out.split(para).length - 1;
  assert.strictEqual(occurrences, 1, "CRLF blank-line-separated duplicate must collapse");
});

test("dedupe: tolerates whitespace-only blank lines between paragraphs", () => {
  // Pattern observed in some line-by-line accumulators: paragraphs
  // separated by `\n \n` (one space on the otherwise-blank line).
  // The paragraph splitter must treat this as a real boundary.
  const para = "A long enough paragraph that easily exceeds the forty character threshold for substantive content.";
  const input = `${para}\n \n${para}\n\nThis operation matches one of your protected patterns in Gryphon.`;
  const out = _dedupeConsecutiveParagraphs(input);
  const occurrences = out.split(para).length - 1;
  assert.strictEqual(occurrences, 1, "whitespace-only blank lines must still split paragraphs for dedupe");
});

test("dedupe: collapses single-newline-separated duplicates (not just blank-line)", () => {
  // The paragraph-level split uses \n{2,}, so duplicates separated
  // by a single \n would leak past as one paragraph with internal
  // duplication. The first-pass inline regex catches that case.
  // User report 2026-05-04 (macOS).
  const sentence = "The gist-axios-supply-chain-compromise.md file details a critical supply-chain attack on the axios npm package.";
  const input = `${sentence}\n${sentence}\n\nThis operation matches one of your protected patterns in Gryphon (destructive operation).`;
  const out = _dedupeConsecutiveParagraphs(input);
  const occurrences = out.split(sentence).length - 1;
  assert.strictEqual(occurrences, 1, "single-newline duplicate must collapse to one");
  assert.ok(out.includes("This operation matches"));
});

test("dedupe: handles three-in-a-row (collapses to one)", () => {
  const para = "Long enough paragraph to count as a substantive block of text we don't want to repeat.";
  const input = `${para}\n\n${para}\n\n${para}\n\nDeny notice.`;
  const out = _dedupeConsecutiveParagraphs(input);
  const occurrences = out.split(para).length - 1;
  assert.strictEqual(occurrences, 1, "three identical paragraphs must collapse to one");
});

test("preamble-strip: 'Tool execution blocked:' before canonical marker is removed (Gemini CLI)", () => {
  // Observed on Gemini CLI Windows 2026-05-04. The CLI's tool-error
  // envelope wraps the hook's `reason` with "Tool execution
  // blocked: " before passing to the model; the model dutifully
  // relays the wrapper. Strip at the chat-view layer so the output
  // matches every other provider's verbatim deny copy.
  const summary = "Gryphon is an Obsidian chat plugin.";
  const input = `${summary}\n\nTool execution blocked: This operation matches one of your protected patterns in Gryphon (destructive operation).`;
  const out = _separateCanonicalBlocks(input);
  assert.ok(!out.includes("Tool execution blocked:"), "preamble must be stripped");
  assert.ok(out.includes("This operation matches one of your protected patterns in Gryphon"));
  assert.ok(out.includes(summary));
});

test("preamble-strip: 'Error:' before canonical marker is removed (legacy/SDK)", () => {
  const input = "Error: This operation matches one of your protected patterns in Gryphon (destructive operation).";
  const out = _separateCanonicalBlocks(input);
  assert.ok(!out.startsWith("Error:"), "preamble must be stripped");
  assert.ok(out.startsWith("This operation matches"));
});

// Removed: "The Gryphon plugin is blocking this request:" used to be a
// forbidden preamble that we stripped. As of 2026-05-04 the canonical
// deny copy itself starts with "The Gryphon plugin is blocking the
// {operation}..." — so that prefix is no longer a wrapper to remove,
// it IS the canonical opening. The strip list now only covers
// CLI/SDK-wrapper preambles (Tool execution blocked:, Error:) that
// land BEFORE the canonical opening.

test("preamble-strip: leaves canonical marker alone when no preamble is present", () => {
  // Idempotent — the byte-identical canonical text passes through
  // unchanged.
  const input = "This operation matches one of your protected patterns in Gryphon (destructive operation).";
  const out = _separateCanonicalBlocks(input);
  assert.strictEqual(out, input);
});

test("preamble-strip: doesn't strip 'Error:' that appears in unrelated narration", () => {
  // The strip is conditional on the preamble appearing IMMEDIATELY
  // before a canonical marker. An "Error:" that introduces other
  // content (not followed by the marker) must pass through.
  const input = "Error: something else happened that wasn't a protected refusal.";
  const out = _separateCanonicalBlocks(input);
  assert.strictEqual(out, input);
});

test("separator: deny copy directly smushed against narration gets a paragraph break", () => {
  const input = "I will now attempt to remove the file.This operation matches one of your protected patterns in Gryphon (destructive operation).\n\nTo allow it: ...";
  const out = _separateCanonicalBlocks(input);
  assert.ok(
    out.includes("the file.\n\nThis operation matches"),
    "must inject \\n\\n between the smushed boundary",
  );
});

test("separator: single-space before deny on same line gets promoted to paragraph break", () => {
  // Some accumulators may emit ". This operation..." instead of
  // ".This operation..." — same visual smush in chat (single space
  // doesn't break a paragraph). Promote to \n\n.
  const input = "I will now attempt to remove the file. This operation matches one of your protected patterns in Gryphon (destructive operation).";
  const out = _separateCanonicalBlocks(input);
  assert.ok(
    out.includes("the file.\n\nThis operation matches"),
    "single-space-after-period should be promoted to paragraph break",
  );
});

test("separator: idempotent — already-separated content is left alone", () => {
  const input = "I will now attempt to remove the file.\n\nThis operation matches one of your protected patterns in Gryphon (destructive operation).";
  const out = _separateCanonicalBlocks(input);
  assert.strictEqual(out, input);
});

test("separator: does not insert a break when the marker is at the start of the text", () => {
  const input = "This operation matches one of your protected patterns in Gryphon (destructive operation).\n\nTo allow it: ...";
  const out = _separateCanonicalBlocks(input);
  assert.strictEqual(out, input, "marker at index 0 must not be prefixed");
});

test("separator: handles 'You declined' fallback marker", () => {
  const input = "OK, I will not delete it.You declined remove on /tmp/x.";
  const out = _separateCanonicalBlocks(input);
  assert.ok(out.includes("not delete it.\n\nYou declined"));
});

test("separator: handles 'User previously denied' cache-hit marker", () => {
  const input = "Will retry now.User previously denied edit on foo.md for this session.";
  const out = _separateCanonicalBlocks(input);
  assert.ok(out.includes("retry now.\n\nUser previously denied"));
});

test("separator: leaves unrelated text untouched", () => {
  const input = "Just a normal summary with no canonical markers in it whatsoever.";
  const out = _separateCanonicalBlocks(input);
  assert.strictEqual(out, input);
});

test("separator: empty string passes through", () => {
  assert.strictEqual(_separateCanonicalBlocks(""), "");
  assert.strictEqual(_separateCanonicalBlocks(null), null);
  assert.strictEqual(_separateCanonicalBlocks(undefined), undefined);
});

test("separator: multiple smushed boundaries on the same string all get fixed", () => {
  // Edge case: two canonical blocks back to back. Both should get
  // separators inserted from preceding non-whitespace content.
  const input = "Done.You declined the first.You declined the second.";
  const out = _separateCanonicalBlocks(input);
  assert.ok(out.includes("Done.\n\nYou declined the first.\n\nYou declined the second."));
});

test("separator: does not promote a normal in-paragraph space (sentence within a paragraph)", () => {
  // Critical: only sentence-terminator + space + canonical marker
  // gets promoted. A canonical marker preceded by a normal mid-
  // sentence space would NOT be smushed in practice, but verify
  // we don't over-promote.
  const input = "The phrase This operation matches one of your protected patterns in Gryphon describes the protection.";
  // The single space before "This operation" is preceded by
  // "phrase" (not a sentence terminator), so we should NOT inject
  // a break.
  const out = _separateCanonicalBlocks(input);
  assert.strictEqual(out, input);
});
