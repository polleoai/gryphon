// Issue #32 tests: emulate separate processes (each Obsidian vault window
// is one) by swapping the process-global state the stores keep on
// `process` and re-requiring the protect sources.
const path = require("path");

const PROTECT_SRC = `${path.sep}protect${path.sep}src${path.sep}`;
function _dropProtectModules() {
  for (const k of Object.keys(require.cache)) if (k.includes(PROTECT_SRC)) delete require.cache[k];
}

/** `as(name, fn)` runs `fn(require(modulePath))` inside process `name`. */
function processes(keys: symbol[], modulePath: string) {
  const states: Record<string, Map<symbol, any>> = {};
  const g = process as any;
  const install = (m: Map<symbol, any>) => {
    for (const k of keys) delete g[k];
    for (const [k, v] of m) if (v !== undefined) Object.defineProperty(g, k, { value: v, configurable: true, enumerable: false, writable: true });
  };
  return (name: string, fn: (mod: any) => void) => {
    const saved = new Map(keys.map((k) => [k, g[k]]));
    install(states[name] || new Map());
    _dropProtectModules();
    try { fn(require(modulePath)); } finally {
      states[name] = new Map(keys.map((k) => [k, g[k]]));
      install(saved);
      _dropProtectModules();
    }
  };
}

const SETTINGS_KEYS = [
  Symbol.for("gryphon.securityStoreWrites"),
  Symbol.for("gryphon.securityStoreTrusted"),
  Symbol.for("gryphon.securityServedVaults"),
];
const APPROVALS_KEYS = [
  Symbol.for("gryphon.mcpApprovalsWrites"),
  Symbol.for("gryphon.mcpApprovalsServedVaults"),
];

module.exports = { processes, SETTINGS_KEYS, APPROVALS_KEYS };
