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
const { PACKAGE_INSTALL_COMMAND_PATTERNS } = require("../src/constants");

const ctx = () => ({
  vaultRoot: "/tmp/vault",
  plugin: { settings: { protectedCommandsEnabled: true, protectedCommandsDisabled: [], protectedCommandsCustom: [] } },
});
const detects = (cmd) => assert.ok(classify("Bash", { command: cmd }, ctx()), `should detect: ${cmd}`);
const doesNotDetect = (cmd) => assert.equal(classify("Bash", { command: cmd }, ctx()), null, `should NOT detect: ${cmd}`);

test("pip install detected", () => detects("pip3 install -r requirements.txt"));
test("python -m pip install detected", () => detects("python3 -m pip install evil"));
test("uv pip install detected", () => detects("uv pip install evil"));
test("uv add detected", () => detects("uv add evil"));
test("pipx install detected", () => detects("pipx install evil"));
test("npm install detected", () => detects("npm install"));
test("npm i detected", () => detects("npm i evil-pkg"));
test("npm ci detected", () => detects("npm ci"));
test("pnpm add detected", () => detects("pnpm add evil"));
test("yarn add detected", () => detects("yarn add evil"));
test("bun add detected", () => detects("bun add evil"));
test("gem install detected", () => detects("gem install evil"));
test("cargo install detected", () => detects("cargo install evil"));
test("go install detected", () => detects("go install evil@latest"));
test("apt-get install detected", () => detects("sudo apt-get install -y evil"));
test("brew install detected", () => detects("brew install evil"));
test("conda install detected", () => detects("conda install evil"));
test("poetry add detected", () => detects("poetry add evil"));
test("bundle install detected", () => detects("bundle install"));

test("npm run build NOT detected", () => doesNotDetect("npm run build"));
test("pip --version NOT detected", () => doesNotDetect("pip --version"));
test("cargo build NOT detected", () => doesNotDetect("cargo build"));
test("apt list NOT detected", () => doesNotDetect("apt list --installed"));
test("go test NOT detected", () => doesNotDetect("go test ./..."));
test("yarn build NOT detected", () => doesNotDetect("yarn build"));

test("PACKAGE_INSTALL_COMMAND_PATTERNS is a non-empty string array", () => {
  assert.ok(Array.isArray(PACKAGE_INSTALL_COMMAND_PATTERNS));
  assert.ok(PACKAGE_INSTALL_COMMAND_PATTERNS.length >= 6);
  for (const p of PACKAGE_INSTALL_COMMAND_PATTERNS) assert.equal(typeof p, "string");
});

const { buildDisallowedTools } = require("../src/cc-disallow-translator");

const ctxMuted = () => ({
  vaultRoot: "/tmp/vault",
  plugin: { settings: { protectedCommandsEnabled: true, protectedCommandsDisabled: [], protectedCommandsCustom: [], blockPackageInstall: false } },
});

test("blockPackageInstall=false mutes classify for installs", () => {
  assert.equal(classify("Bash", { command: "pip3 install evil" }, ctxMuted()), null);
  assert.equal(classify("Bash", { command: "npm install" }, ctxMuted()), null);
});
test("blockPackageInstall=false still detects non-install protected commands", () => {
  assert.ok(classify("Bash", { command: "eval \"$X\"" }, ctxMuted()));
});
test("blockPackageInstall=false drops install globs from disallowedTools", () => {
  const globs = buildDisallowedTools({ protectedCommandsEnabled: true, blockPackageInstall: false });
  assert.ok(!globs.some((g) => g.includes("pip install")), "no pip install glob when muted");
  assert.ok(!globs.some((g) => g.includes("npm install")), "no npm install glob when muted");
});
test("blockPackageInstall default (unset) keeps installs armed", () => {
  assert.ok(classify("Bash", { command: "pip3 install evil" }, ctx()));
  const globs = buildDisallowedTools({ protectedCommandsEnabled: true });
  assert.ok(globs.some((g) => g.includes("pip install")), "pip install glob present by default");
});
