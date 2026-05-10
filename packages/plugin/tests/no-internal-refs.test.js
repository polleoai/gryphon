/**
 * Distributable-hygiene guard.
 *
 * Gryphon is a standalone Obsidian plugin. No file in this repository —
 * source, docs, tests, fixtures, comments — may reference internal
 * consumer project names. Those names leak private product context and
 * break the "standalone plugin" framing that users installing from the
 * community store expect.
 *
 * This test fails if any tracked file contains a forbidden token. The
 * token list is project-level policy (see CONTRIBUTING.md).
 *
 * When a legitimate new token needs to be added (e.g., a new consumer
 * project), append it to FORBIDDEN_TOKENS and scrub the repo in the
 * same commit.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// Case-insensitive forbidden substrings. Each entry is a plain string
// (not a regex) searched across every tracked file's contents.
//
// Internal consumer project names (policy — see CONTRIBUTING.md).
const FORBIDDEN_TOKENS = [
  "athena",
];

// Files that are permitted to mention the tokens — ONLY this guard test
// and the policy document that explains why. The allowlist is a relative
// path match against the repo root.
//
// Dev-only files explicitly excluded from publish-release.sh's safelist
// are also allowed: they live in the private dev repo and are useful
// there for maintainer workflow context, but never reach the public
// release repo and never reach end users. publish-release.sh is the
// authoritative shipping gate; this allowlist mirrors its dev-only
// exclusions so this test doesn't flag content that isn't going
// public anyway.
const ALLOWLIST = new Set([
  "tests/no-internal-refs.test.js",
  "CONTRIBUTING.md",  // may describe the policy itself — still scrubbed below
  // Dev-only scrub script that references forbidden tokens as part of
  // its own sed/perl rules. Not shipped to the public repo
  // (publish-release.sh deliberately excludes scripts/ from the
  // snapshot), so its mentions never reach end users.
  "scripts/publish-release.sh",
  // Dev-only docs (publish-release.sh's docs/ safelist only ships
  // docs/screenshots/ and docs/adr/). These contain maintainer workflow
  // notes, retrospectives, and git operation logs that intentionally
  // reference internal usernames and local filesystem paths so future
  // sessions can reconstruct context.
  "docs/maintainer-workflows.md",
  "docs/todo.md",
  "docs/git-ops-log.md",
  "docs/announcements.md",
  "docs/code-review-findings.md",
  "docs/qa-findings.md",
  "docs/retrospectives/2026-04-24-launch-and-announcements.md",
  "docs/v0.5.0-attack-detector-design.md",
  "docs/v0.6.0-hook-integration-design.md",
  "docs/v0.6.0-implementation-plan.md",
  "docs/v1.1.0-sdk-auto-compact-design.md",
  "docs/v1.1.0-sdk-auto-compact-plan.md",
  // Dev-only agent-guidance files + dev-only release tooling.
  // Documents the Gryphon → Athena consumption model. Not in
  // publish-release.sh's safelist, so never reach the public repo.
  "CLAUDE.md",
  "AGENTS.md",
  "scripts/cut-public-release.sh",
  "scripts/notify-athena-release.sh",
]);

// Binary-like extensions are skipped (images, fonts, etc.). Text-ish
// files are scanned. Keep this narrow so we catch accidental leaks in
// unusual text formats (.yml, .toml, future config files).
const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf",
  ".woff", ".woff2", ".ttf", ".otf",
  ".zip", ".gz",
]);

function listTrackedFiles(repoRoot) {
  // `git ls-files` excludes untracked files and .gitignore'd paths —
  // exactly the set that would be pushed to GitHub.
  const out = execFileSync("git", ["-C", repoRoot, "ls-files"], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return out.split("\n").filter((l) => l.length > 0);
}

test("no forbidden internal-project tokens appear in tracked files", () => {
  const repoRoot = path.resolve(__dirname, "..");
  const files = listTrackedFiles(repoRoot);
  const leaks = [];

  for (const rel of files) {
    if (ALLOWLIST.has(rel)) continue;
    if (BINARY_EXTS.has(path.extname(rel).toLowerCase())) continue;

    const full = path.join(repoRoot, rel);
    let content;
    try {
      content = fs.readFileSync(full, "utf8");
    } catch {
      // File might have been removed between git ls-files and here
      // (rare but possible during concurrent edits). Skip — next test
      // run will catch it if it matters.
      continue;
    }

    const lower = content.toLowerCase();
    for (const token of FORBIDDEN_TOKENS) {
      const tok = token.toLowerCase();
      let idx = lower.indexOf(tok);
      while (idx !== -1) {
        // Report with a short context snippet so fixes are easy.
        const start = Math.max(0, idx - 20);
        const end = Math.min(content.length, idx + tok.length + 20);
        leaks.push({
          file: rel,
          token,
          snippet: content.slice(start, end).replace(/\n/g, "\\n"),
        });
        idx = lower.indexOf(tok, idx + tok.length);
      }
    }
  }

  if (leaks.length > 0) {
    const report = leaks
      .map((l) => `  ${l.file}: "${l.token}" in "…${l.snippet}…"`)
      .join("\n");
    assert.fail(
      `Found ${leaks.length} forbidden-token occurrence(s) in tracked files:\n${report}\n\n` +
      `See CONTRIBUTING.md "Gryphon ships standalone" rule. Scrub the references or, for legitimately new tokens, update FORBIDDEN_TOKENS in tests/no-internal-refs.test.js.`
    );
  }
});
