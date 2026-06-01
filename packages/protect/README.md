# @gryphon/protect

`@gryphon/protect` is the security and permission-gate layer extracted from the
Gryphon Obsidian plugin per [ADR 0006][adr-0006]. Its scope is limited to two
concerns: permission gating and command/attack classification. It does not
contain an MCP client, an agentic orchestration loop, or any consumer domain
logic (see [ADR 0007][adr-0007]). Two callers consume it today: the Gryphon
plugin shell running inside Obsidian, and Peitho, a headless Node host that
implements its own tool-use loop and asks `@gryphon/protect` for a
`decide()` verdict on each action before executing it.

---

## Quick start — Obsidian plugin (legacy path)

Existing Obsidian-side callers pass `plugin` and (optionally) `settings`.
Nothing changes for this path.

```javascript
const { createProtectionContext } = require("@gryphon/protect");

const ctx = createProtectionContext({
  plugin: this,            // Obsidian plugin instance
  settings: this.settings, // settings snapshot (falls back to plugin.settings)
  hostAdapter: this.hostAdapter,
});

// ctx.classify, ctx.prepareSpawn, ctx.isAvailable work as before.
```

---

## Quick start — headless (Peitho path)

Non-Obsidian callers omit `plugin` and pass a `config` object instead.

```javascript
const { createProtectionContext } = require("@gryphon/protect");

const ctx = createProtectionContext({
  config: {
    permissionMode: "default",
    protectedPathsEnabled: true,
    protectedCommandsEnabled: true,
    protectedMode: true,
    autoDenyProtected: false,
    // ... other keys from the policy-primitives table below
  },
  // hostAdapter omitted → HeadlessHostAdapter (console.log + globalThis.fetch)
  onDecision: ({ ts, tool, args_summary, decision, reason }) => {
    auditLog.write({ ts, tool, args_summary, decision, reason });
  },
});

const result = await ctx.decide({
  tool: "bash",
  args: { command: "rm -rf /etc" },
  mode: "default",                      // optional; defaults to config.permissionMode
  scope: { allowedRoots: ["/tmp/sandbox"] },
});
// result = { decision: "deny", reason: "destructive-operation" }

if (result.decision === "deny") {
  // Refuse the action. result.reason names the matched category.
} else {
  // Execute the tool yourself.
}
```

---

## The `decide()` contract

```javascript
async decide({ tool, args, mode, scope })
  → Promise<{ decision: "allow" | "deny", reason: string | null }>
```

### Input fields

**`tool`** (string, required)  
The tool name as the provider emits it. Case-insensitive normalization is
applied internally. Common values: `"bash"`, `"read_file"`, `"write_file"`,
`"edit_file"`. The normalizer maps provider-specific aliases (e.g. Codex's
`"RunBashSession"`) to canonical names.

**`args`** (object, required)  
The tool's input object, in the same shape the tool definition requires.
For bash tools: `{ command: "..." }`. For file tools: `{ path: "..." }` or
`{ file_path: "..." }`.

**`mode`** (string, optional)  
Permission-mode override for this call. When omitted, falls back to
`config.permissionMode`, then `"default"`. Accepted values (see also
`packages/protect/src/permission-gate.js`):

| Value | Behavior |
|---|---|
| `"default"` | Prompt the user for protected operations. In headless mode, would-have-prompted collapses to `"deny"` (see note below). |
| `"acceptEdits"` | Auto-accept file-edit operations silently; protected commands still gate. |
| `"bypassPermissions"` | Auto-accept all operations, including protected ones (YOLO). |
| `"plan"` | Refuse all write/exec operations; return deny with a plan-only reason. |

**`scope`** (object, optional)  
`{ allowedRoots?: string[] }` — the first element of `allowedRoots` is used
as the vault-root equivalent for path-confinement checks. Paths outside this
root are flagged by the classifier. If `scope` is omitted or `allowedRoots`
is empty, path-confinement checks have no root to compare against.

### Return value

```
{ decision: "allow" | "deny", reason: string | null }
```

`reason` is `null` on a fast-path allow (unclassified tool, read-only
operation, or all toggles disabled). On deny it names the matched category:
`"destructive-operation"`, `"persistent-execution"`, `"runs-arbitrary-code"`,
etc. The full category list is in `constants.PROTECTED_CATEGORIES`.

---

## Sync vs async; "prompt" decision

`decide()` is **async — always `await` it.**

In practice the promise resolves in the next microtask for headless callers
(no I/O is performed; the no-modal fallback in `checkPermission` returns
synchronously). The async signature is part of the public contract so that
future changes — for example, a HostAdapter-injected prompt callback — do not
require a signature break.

**`"prompt"` is not a current return value.** In headless contexts there is
no modal renderer, so operations that would normally prompt the user collapse
to `"deny"`. Requirement S1 from `docs/consumer-requirements.md` identifies
a future enhancement that may add `{ decision: "prompt" }` once
`checkPermission` can signal intent before falling back. Until then, the
two-state contract (`"allow"` / `"deny"`) is stable.

---

## The `HostAdapter` contract

`HostAdapter` is a duck-typed object with two methods:

```
{
  notify(message: string, options?: object): void,
  fetch(url: string, options?: object): Promise<Response>,
}
```

Headless callers have two options:

1. **Omit `hostAdapter`** — `HeadlessHostAdapter` is used automatically.
   It routes `notify()` to `console.log` and `fetch()` to `globalThis.fetch`.

2. **Pass a custom implementation** — for example, a structured-logger
   adapter that routes `notify()` calls into your application log.

The Obsidian plugin shell passes a native adapter that routes `notify()` to
Obsidian's `Notice` API and `fetch()` to Obsidian's `requestUrl` wrapper.
Headless callers do not need to replicate that.

---

## Policy primitives (the `config` / `settings` shape)

The `config` bag accepted by `createProtectionContext` uses the same key
names as the plugin's `DEFAULT_SETTINGS`. The keys relevant to headless
callers:

| Key | Type | Default | Meaning |
|---|---|---|---|
| `permissionMode` | string | `"default"` | Active permission mode: `"default"`, `"acceptEdits"`, `"bypassPermissions"`, or `"plan"`. |
| `protectedMode` | boolean | `true` | Master switch. When `false`, all enforcement is disabled. |
| `autoDenyProtected` | boolean | `false` | When `true`, protected operations are denied automatically rather than prompting. In headless mode the gate already auto-denies; this flag has more effect in Obsidian contexts. |
| `protectedPathsEnabled` | boolean | `true` | Enables the default protected-path catalog (`DEFAULT_PROTECTED_PATHS`). |
| `protectedPathsDisabled` | string[] | `[]` | Pattern strings from `DEFAULT_PROTECTED_PATHS` to suppress individually. |
| `protectedPathsCustom` | object[] | `[]` | Additional path rules in the `{ pattern, category, userRisk }` shape. |
| `protectedCommandsEnabled` | boolean | `true` | Enables the default protected-command catalog (`DEFAULT_PROTECTED_COMMANDS`). |
| `protectedCommandsDisabled` | string[] | `[]` | Pattern strings from `DEFAULT_PROTECTED_COMMANDS` to suppress individually. |
| `protectedCommandsCustom` | object[] | `[]` | Additional command rules in the `{ pattern, category, userRisk }` shape. |

For the complete key list including LLM-provider and UI settings that are
irrelevant to headless callers, see `packages/plugin/src/constants.js`
(`DEFAULT_SETTINGS`). The source of truth for protected-pattern data is
`packages/protect/src/constants.js`.

---

## Audit sink (S3)

Pass `onDecision` to `createProtectionContext` to receive a structured record
for every gate decision. The callback is invoked synchronously after the
decision is computed, before `decide()` returns.

```javascript
const ctx = createProtectionContext({
  config,
  onDecision: ({ ts, tool, args_summary, decision, reason }) => {
    auditLog.write({ ts, tool, args_summary, decision, reason });
  },
});
```

**Record fields:**

| Field | Type | Notes |
|---|---|---|
| `ts` | number | `Date.now()` at decision time (ms since epoch) |
| `tool` | string | Raw tool name as passed to `decide()` |
| `args_summary` | string | Human-readable args summary; strings truncated at 80 chars, nested objects shown as `[object]`, arrays as `[array]` |
| `decision` | `"allow"` \| `"deny"` | Gate verdict |
| `reason` | string \| null | Matched category (e.g. `"destructive-operation"`), or `null` on fast-path allow |

**Isolation:** if `onDecision` throws, the error is surfaced via
`hostAdapter.notify(…, { level: "warn" })` and swallowed — it never
propagates to the caller or affects the gate's decision. If you need
reliability guarantees, buffer internally inside the sink.

Exact record shapes and edge cases are covered by the S3 tests in
`packages/protect/tests/headless-decide.test.js`.

---

## Reference

- **[ADR 0007 — scope: LLM and security only][adr-0007]** — what
  `@gryphon/protect` does and deliberately does not do.
- **[`docs/consumer-requirements.md`][consumer-req]** — full requirement
  IDs for the Peitho integration: S1 (callable `decide()` gate), S2 (policy
  primitives), S3 (audit sink — active), S4 (classifier), B4
  (IPC-server-not-required smoke test).
- **[ADR 0006 — three-axis workspace split][adr-0006]** — why `protect` is
  a separate package.

[adr-0006]: ../../docs/adr/0006-three-axis-workspace-split.md
[adr-0007]: ../../docs/adr/0007-scope-llm-and-security-only.md
[consumer-req]: ../../docs/consumer-requirements.md
