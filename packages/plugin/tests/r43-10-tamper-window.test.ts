// R43-10 / R43-19: the turn-end security check reports a failed undo, and
// names the provider that actually ran the turn.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

const stubPath = require.resolve("./_stubs/obsidian");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "obsidian") return stubPath;
  return originalResolve.call(this, request, ...args);
};

const { Notice } = require("obsidian");
const { GryphonChatView } = require("../src/chat-view");

function fakeView() {
  const v = Object.create(GryphonChatView.prototype);
  v.refreshToolbarLabels = () => {};
  v._updateRestApiChip = () => {};
  return v;
}

test("R43-10: an undo that fails is a visible, persistent notice", () => {
  const store = require("../../protect/dist/security-settings-store");
  const orig = store.checkSecurityStoreTamper;
  store.checkSecurityStoreTamper = () => { throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" }); };
  Notice.shown.length = 0;
  try {
    const v = fakeView();
    v._turnProviderKind = "codex-cli";
    v._endTurnTamperWindow({ raw: "{}" }, "claude-code");
    const n = Notice.shown.find((x) => /couldn't undo it/.test(String(x.message || x.msg || x.text || "")));
    assert.ok(n, `notices: ${JSON.stringify(Notice.shown.map((x) => x.message || x.msg || x.text))}`);
    assert.match(String(n.message || n.msg || n.text), /Codex/);
  } finally {
    store.checkSecurityStoreTamper = orig;
  }
});
