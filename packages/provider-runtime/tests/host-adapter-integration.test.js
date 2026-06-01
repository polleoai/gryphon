const { test } = require("node:test");
const assert = require("node:assert/strict");
const factory = require("../src/factory");
const { HeadlessHostAdapter } = require("../src/host-adapter");

test("createProvider accepts and propagates hostAdapter", () => {
  const adapter = new HeadlessHostAdapter();
  const provider = factory.createProvider({
    kind: "anthropic-api",
    config: { apiKey: "test-key", model: "claude-sonnet-4-6" },
    hostAdapter: adapter,
  });
  assert.equal(provider.hostAdapter, adapter, "provider should expose its hostAdapter");
});

test("createProvider defaults to HeadlessHostAdapter when none provided", () => {
  const provider = factory.createProvider({
    kind: "anthropic-api",
    config: { apiKey: "test-key", model: "claude-sonnet-4-6" },
  });
  assert.ok(provider.hostAdapter, "default adapter should be present");
  assert.equal(typeof provider.hostAdapter.notify, "function");
  assert.equal(typeof provider.hostAdapter.fetch, "function");
});
