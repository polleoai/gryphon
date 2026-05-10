# ADR 0006 — Three-axis workspace split: provider-config / provider-runtime / protect

**Status**: Accepted (2026-05-09)
**Context window**: v1.5.0 — internal architectural reorganization; no behavior change for end users; Athena's submodule path unchanged.

## Context

By the end of the v1.4 series, Gryphon's `src/` tree had grown into ~15,000 lines spanning three distinct concerns:

1. **LLM integration** — six provider implementations (Claude Code, Anthropic API, OpenAI API, Google API, Codex CLI, Gemini CLI), the factory that picks one, the tool loops, pricing tables, model dropdowns.
2. **Runtime protection** — HookDispatcher, IPC server, attack-detector classifier, permission-gate, protected-pattern catalog, six standalone hook scripts.
3. **The Obsidian plugin shell** — chat-view, settings tab, ribbon icons, view types, history persistence — the parts genuinely tied to Obsidian's UI runtime.

These concerns share zero domain knowledge with each other and change at very different rates. Provider implementations churn whenever a vendor ships a new model. Protection logic churns when threat research finds a new attack pattern. The plugin shell churns when Obsidian releases a new version or when chat UX evolves. Yet they all sat in one tree, one build, one release artifact — which meant a model-table update required a full plugin rebuild and an Athena pin advance.

The trigger for the rework was the user adding `farion1231/cc-switch` to the Athena KB and asking whether we could "further separate the LLM integration from the protection layer." cc-switch turned out to be Tauri 2 + Rust + SQLite (not a viable dependency), but it demonstrated a real architectural lesson: configuration-and-selection can be its own layer, fully decoupled from runtime safety.

## Decision

Reorganize the codebase into **four npm workspaces**, each with a single concern:

```
packages/
  provider-config/     # cc-switch-shaped: pure data + selection
  provider-runtime/    # spawn / stream / abort / retry across 6 providers
  protect/             # hook orchestration + permission + injection-detection
  plugin/              # Obsidian shell (the shipping artifact)
```

The dependency graph runs strictly downhill — no cycles:

```
plugin ──► provider-runtime ──► provider-config
   │             │
   ▼             ▼
protect       protect (optional, via injected ProtectionContext)
```

### What goes where

| Concern | Package | Examples |
|---|---|---|
| Provider catalog, pricing, model dropdowns, per-vendor extra-args allowlists | `@gryphon/provider-config` | `pricing/openai.js`, `pricing/google.js`, `extra-args-filter.js` |
| Provider implementations, factory, tool loops, schema translators | `@gryphon/provider-runtime` | `factory.js`, `providers/<kind>/*.js`, `utils.js` |
| HookDispatcher, IPC server, hook scripts, protected-pattern catalog, attack-detector, permission-gate, deny copy, injection patterns | `@gryphon/protect` | `hook-dispatcher.js`, `permission-ipc-server.js`, `attack-detector.js`, `hooks/*.js`, `constants.js` |
| Obsidian-specific: chat-view, settings tab, ribbon icon, view persistence, plugin lifecycle | `@gryphon/plugin` | `plugin.js`, `chat-view.js`, `bundled-skills.js` |

### The ProtectionContext contract

The runtime layer treats protection as opaque. A consumer (Obsidian plugin or a future non-Obsidian host) builds a context via `createProtectionContext({ plugin, settings })` and passes it into the runtime. Runtime never imports anything from protect except via this context.

```js
const { createProtectionContext } = require("@gryphon/protect");
const { createProvider } = require("@gryphon/provider-runtime");

const ctx = createProtectionContext({ plugin, settings });
const provider = createProvider(plugin, cwd, { ...options, protectionContext: ctx });
```

A non-Obsidian consumer can pass `null` for unprotected mode — runtime works without protection.

### Distribution shape

For v1.5.0, all four workspaces ship together as a single Obsidian plugin (`main.js` + `manifest.json` + `styles.css` + `hooks/` at repo root). Athena's submodule pin path is unchanged. The workspace split is purely internal organization.

The split prepares — but does not commit to — three future distribution flavors:

1. **Open-core**: extract `@gryphon/protect/src/` to a private repo and ship a closed-source npm package (`@polleoai/gryphon-protect`) with a commercial license. Public repo's `packages/protect/` becomes a thin re-export wrapper. Plugin keeps building from the public repo; commercial customers gain premium content channels via the closed library.
2. **Standalone library**: `@gryphon/protect`, `@gryphon/provider-runtime`, `@gryphon/provider-config` published as standalone npm packages, MIT-licensed by default, for non-Obsidian hosts (CLI tools, web apps, VS Code plugins) that want the protection or LLM abstractions independently.
3. **Engine + content split**: protected-pattern catalog and injection-pattern catalog migrate from `packages/protect/src/constants.js` to versioned JSON content files (`packages/protect/content/*.json` with `schemaVersion`). Engine reads JSON at boot; consumers can override or augment via a `loadContent()` hook. Future content updates ship via the AV-style content-update channel rather than full library bumps.

None of these distribution flavors is committed in v1.5.0. The architecture is set up so any of them can happen as a 1-week migration rather than an architectural redesign.

## Consequences

**Wins**:

- **Clear concerns per package**. A reader can understand provider-config in an afternoon without absorbing the protection layer; same for protect without provider implementations.
- **Per-axis change frequency is honored**. Adding a new provider (e.g. Mistral) touches `packages/provider-runtime/`. Adding a new protected path touches `packages/protect/`. Neither cascades.
- **Test surface partitioned**. Each workspace has its own tests (502 in protect, 343 in provider-runtime, 51 in provider-config, 156 in plugin). A test failure points to the right axis.
- **Cross-package boundary is checkable**. The dependency graph is acyclic and downhill; future tooling can lint it (eslint `no-restricted-paths`).
- **Future open-core distribution is unblocked**. Closing one workspace does not require redesigning the other three.
- **Athena consumption preserved**. Submodule pin path (`vendor/gryphon/main.js` etc.) is unchanged. Athena does not need to change anything to consume v1.5.0.

**Costs**:

- **Cross-package relative imports during the transition**. A few protect-side files reach back into provider-runtime (`../../provider-runtime/src/utils`, `../../provider-runtime/src/factory`) for helpers that conceptually should live in protect. These are documented inline as "interim — to be resolved in a follow-up refactor." The only practical impact is a slightly less clean dependency graph until those moves happen.
- **Plugin still has duplicate copies of the protected-pattern arrays**. `packages/plugin/src/constants.js` retains its original copies of `DEFAULT_PROTECTED_PATHS`, `DEFAULT_PROTECTED_COMMANDS`, and `PROTECTED_CATEGORIES` to avoid a mass-deletion that changed too much in one shot. The canonical copies now live in `packages/protect/src/constants.js`. A follow-up pass replaces the plugin's copies with re-exports from `@gryphon/protect`.
- **Build orchestration moved**. Root `npm run build` dispatches into `@gryphon/plugin`'s build, which `chdir`s to repo root and continues to emit `main.js` + `hooks/` at the same paths as before. Documented in repo CLAUDE.md.
- **Several `obsidian` requires made lazy**. `packages/protect/src/permission-gate.js` previously imported `{ Modal, Setting }` from `obsidian` at module load. Test harnesses outside Obsidian (Node `node:test` runners that hadn't registered an `obsidian` stub) crashed when transitively requiring protect helpers. The fix moved the `require("obsidian")` inside `_showPermissionModal`, which is the only function that uses it. This pattern of "lazy UI imports" is now table stakes for any module that's reachable from non-UI code paths.

## What's deferred

These items are scoped but not shipped in v1.5.0. Each is a separate follow-up commit, not a separate stage.

- **Engine/content JSON extraction**. Move `DEFAULT_PROTECTED_PATHS` etc. from `packages/protect/src/constants.js` to `packages/protect/content/*.json` with `schemaVersion: 1`. Add a `loadContent()` extension point. Cost: ~1 day. Buys the AV-DAT-style update channel.
- **claude-code provider migration off legacy `buildHookSettings` direct path**. Currently functions; the migration would route claude-code through `protectionContext.prepareSpawn` like codex-cli and gemini-cli do, eliminating the asymmetry. Cost: ~1 day.
- **factory.js split**. Move `getActiveProviderKind`, `detectAvailable`, `explainUnavailable` from `@gryphon/provider-runtime/src/factory.js` to `@gryphon/provider-config/src/resolve.js`. Implement `resolveConfig({ settings }) → ResolvedProviderConfig`. Cost: ~1 day. Cleans the one cross-package back-reference from protect into runtime.
- **Plugin's duplicate constants**. Replace plugin's local copies with re-exports from `@gryphon/protect`. Cost: ~30 minutes once the consumer side is verified to import via the package.
- **eslint `no-restricted-paths`**. Add a lint rule preventing inadvertent cross-package back-references. Cost: ~1 hour.
- **`createProtectionContext` adoption inside the plugin**. The factory landed in v1.5.0, but the plugin still wires IPC + dispatcher + classify directly via the older module-level imports. Migrating the plugin to use `createProtectionContext` end-to-end is a follow-up cleanup that doesn't change behavior.

## What's NOT in scope

- **Any commercial or licensing change**. v1.5.0 ships as MIT, public, in `polleoai/gryphon`. The open-core path is enabled but not committed.
- **A new provider** (Ollama, LM Studio, Mistral, etc.). Deferred per ADR 0002.
- **Plugin renaming or view-type changes**. Athena's vault state and Obsidian Community Plugins listing are unaffected.
- **Issue #37** (LLM-summary at seed time) — substantial v1.4 design work, unrelated to this refactor.

## References

- ADR 0002 — Provider integration strategy (no LiteLLM)
- ADR 0003 — OpenAI + Google providers
- ADR 0005 — HookDispatcher: a shared CLI hook orchestrator
- `packages/protect/README.md`
- `packages/provider-runtime/README.md`
- `packages/provider-config/README.md`
- Plan file (transient): `~/.claude/plans/hashed-toasting-bengio.md`
