const { test } = require("node:test");
const assert = require("node:assert/strict");

test("decide() works in a process with no 'obsidian' module and no IPC server", async () => {
  // Pre-condition: require("obsidian") should throw in this process.
  let obsidianAvailable = false;
  try { require("obsidian"); obsidianAvailable = true; } catch (_) { /* expected */ }
  assert.equal(obsidianAvailable, false, "test setup invariant: obsidian must not be installed");

  const { createProtectionContext } = require("../src/index");
  const ctx = createProtectionContext({
    config: {
      permissionMode: "default",
      allowedRoots: ["/tmp/peitho-sandbox"],
      protectedPathsEnabled: true,
    },
    // hostAdapter omitted — default HeadlessHostAdapter used
  });

  assert.equal(typeof ctx.decide, "function", "ctx.decide must be a function");

  // A benign read inside the allowed root → allow
  // read_file normalises to Read (read-only, not gated) → classify returns null
  const allow = await ctx.decide({
    tool: "read_file",
    args: { path: "/tmp/peitho-sandbox/doc.md" },
    mode: "default",
    scope: { allowedRoots: ["/tmp/peitho-sandbox"] },
  });
  assert.equal(allow.decision, "allow");

  // A destructive op against system path → deny
  // bash "rm -rf /etc" matches destructive-operation pattern
  // headless (no plugin.app) → checkPermission returns {allow:false}
  const deny = await ctx.decide({
    tool: "bash",
    args: { command: "rm -rf /etc" },
    mode: "default",
    scope: { allowedRoots: ["/tmp/peitho-sandbox"] },
  });
  assert.equal(deny.decision, "deny");
  assert.ok(deny.reason, "deny should include a reason");
});

test("decide() honors config.protectedCommandsEnabled toggle (headless settings actually wire up)", async () => {
  const { createProtectionContext } = require("../src/index");

  // With protectedCommandsEnabled: true (default) — the destructive command is denied.
  const ctxOn = createProtectionContext({
    config: { permissionMode: "default", protectedCommandsEnabled: true },
  });
  const denyResult = await ctxOn.decide({
    tool: "bash",
    args: { command: "rm -rf /etc" },
    mode: "default",
    scope: { allowedRoots: ["/tmp/sb"] },
  });
  assert.equal(denyResult.decision, "deny");

  // With protectedCommandsEnabled: false — the same command is allowed
  // (settings actually flow into the classifier from headless config).
  const ctxOff = createProtectionContext({
    config: { permissionMode: "default", protectedCommandsEnabled: false },
  });
  const allowResult = await ctxOff.decide({
    tool: "bash",
    args: { command: "rm -rf /etc" },
    mode: "default",
    scope: { allowedRoots: ["/tmp/sb"] },
  });
  assert.equal(allowResult.decision, "allow",
    "with protectedCommandsEnabled:false, headless config must disable command classification — proves ctx.settings is consulted");
});

test("decide() invokes onDecision with structured audit record (S3)", async () => {
  const { createProtectionContext } = require("../src/index");
  const records = [];
  const ctx = createProtectionContext({
    config: { permissionMode: "default" },
    onDecision: (r) => records.push(r),
  });

  await ctx.decide({
    tool: "bash",
    args: { command: "rm -rf /etc" },
    mode: "default",
    scope: { allowedRoots: ["/tmp/sb"] },
  });

  assert.equal(records.length, 1);
  const rec = records[0];
  assert.ok(typeof rec.ts === "number" && rec.ts > 0, "should include timestamp");
  assert.equal(rec.tool, "bash");
  assert.equal(rec.decision, "deny");
  assert.ok(rec.reason);
  assert.ok(rec.args_summary, "should summarise args (not the full args object)");
  assert.match(rec.args_summary, /rm/);
  // Must NOT include the raw args object reference
  assert.equal(typeof rec.args_summary, "string");
});

test("decide() handles a throwing onDecision without surfacing to caller (S3 isolation)", async () => {
  const { createProtectionContext } = require("../src/index");
  const ctx = createProtectionContext({
    config: { permissionMode: "default" },
    onDecision: () => { throw new Error("sink crashed"); },
  });
  // Must not throw — sink errors are isolation-failures and must not
  // affect the gate's decision.
  const r = await ctx.decide({
    tool: "read_file",
    args: { path: "/tmp/x" },
    mode: "default",
    scope: { allowedRoots: ["/tmp"] },
  });
  assert.ok(r.decision, "decision should still be returned");
});

test("decide() with no onDecision is unchanged (backwards compat)", async () => {
  const { createProtectionContext } = require("../src/index");
  const ctx = createProtectionContext({
    config: { permissionMode: "default" },
    // no onDecision
  });
  const r = await ctx.decide({
    tool: "read_file",
    args: { path: "/tmp/x" },
    mode: "default",
    scope: { allowedRoots: ["/tmp"] },
  });
  assert.ok(r.decision);
});

test("summariseArgs handles unusual inputs without crashing (S3 robustness)", async () => {
  const { createProtectionContext } = require("../src/index");
  const records = [];
  const ctx = createProtectionContext({
    config: { permissionMode: "default" },
    onDecision: (r) => records.push(r),
  });

  // Pass odd args shapes — should NOT crash:
  await ctx.decide({
    tool: "weird",
    args: {
      longString: "x".repeat(200),
      nested: { deep: { object: 1 } },
      arr: [1, 2, 3],
      n: 42,
      b: true,
      nullVal: null,
      undef: undefined,   // <-- NEW: must appear as "[undefined]" not be silently dropped
    },
    mode: "default",
    scope: { allowedRoots: ["/tmp"] },
  });

  assert.equal(records.length, 1);
  assert.equal(typeof records[0].args_summary, "string");
  // Long strings get truncated:
  assert.ok(records[0].args_summary.length < 1000, "very long strings must be truncated");
  // Each value type must appear explicitly in args_summary:
  assert.match(records[0].args_summary, /n=42/);
  assert.match(records[0].args_summary, /b=true/);
  assert.match(records[0].args_summary, /nullVal=null/);
  assert.match(records[0].args_summary, /undef=\[undefined\]/);
  assert.match(records[0].args_summary, /arr=\[array\]/);
  assert.match(records[0].args_summary, /nested=\[object\]/);
});

test("decide() emits onDecision even when decision is allow", async () => {
  const { createProtectionContext } = require("../src/index");
  const records = [];
  const ctx = createProtectionContext({
    config: { permissionMode: "default" },
    onDecision: (r) => records.push(r),
  });

  await ctx.decide({
    tool: "read_file",
    args: { path: "/tmp/peitho-sandbox/doc.md" },
    mode: "default",
    scope: { allowedRoots: ["/tmp/peitho-sandbox"] },
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].decision, "allow");
});

test("summariseArgs redacts known-secret field names (S3 data protection)", async () => {
  const { createProtectionContext } = require("../src/index");
  const records = [];
  const ctx = createProtectionContext({
    config: { permissionMode: "default" },
    onDecision: (r) => records.push(r),
  });
  await ctx.decide({
    tool: "write_file",
    args: {
      path: "/tmp/key.pem",
      new_string: "-----BEGIN RSA PRIVATE KEY-----\nMIIE...",
      content: "secret-token-xyz",
    },
    mode: "default",
    scope: { allowedRoots: ["/tmp"] },
  });
  assert.equal(records.length, 1);
  assert.match(records[0].args_summary, /path=\/tmp\/key\.pem/);
  assert.match(records[0].args_summary, /new_string=\[redacted\]/);
  assert.match(records[0].args_summary, /content=\[redacted\]/);
  // Critically, the secrets must NOT appear in the summary:
  assert.ok(!records[0].args_summary.includes("RSA PRIVATE"), "RSA key must not appear in summary");
  assert.ok(!records[0].args_summary.includes("secret-token-xyz"), "token must not appear in summary");
});
