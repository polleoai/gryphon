# `src/` — back-compat shim layer (since v1.5.1)

The real source code lives under `packages/{plugin,protect,provider-runtime,provider-config}/src/...` since the v1.5.0 three-axis workspace split.

The files in **this** directory are thin re-export shims at the **pre-v1.5 import paths** that consumer projects relied on. They exist solely to preserve the deep-import contract a downstream consumer (currently Athena) was depending on:

```js
// Athena's src/athena/plugin.js (consumer-side)
const { GryphonChatView }  = require("../../vendor/gryphon/src/chat-view");
const { findClaudeBinary } = require("../../vendor/gryphon/src/utils");
// ...
```

These imports resolve through the shims here to the real package locations.

## Contract surface

| Old path | Forwards to |
|---|---|
| `src/chat-view.js` | `packages/plugin/src/chat-view.js` |
| `src/constants.js` | `packages/plugin/src/constants.js` |
| `src/utils.js` | `packages/provider-runtime/src/utils.js` |
| `src/skills.js` | `packages/plugin/src/skills.js` |
| `src/providers/factory.js` | `packages/provider-runtime/src/factory.js` |
| `src/providers/google-api/pricing.js` | `packages/provider-config/src/pricing/google.js` |
| `src/providers/openai-api/pricing.js` | `packages/provider-config/src/pricing/openai.js` |

`packages/plugin/tests/back-compat-shims.test.js` asserts every shim resolves and re-exports a non-empty surface — refactors that move the underlying file must update the shim or break this test.

## Why a shim layer instead of just patching the consumer

The standing model in `CLAUDE.md` says consumer projects "subclass `GryphonChatView` or wrap it via the options bag." That **explicitly authorizes deep imports** as part of the consumer-facing contract. Internal layout refactors (like the v1.5.0 three-axis split) must therefore preserve those import paths or schedule a deliberate breaking-version drop. A shim layer is the clean way to honor the contract while still moving the real source where it belongs.

## Drop-the-shims criteria

The shims can be retired in a future major release when:

1. Every known consumer (Athena, plus any future non-Obsidian consumer) has migrated its imports to the real package paths.
2. The breaking change is announced one minor version ahead in CHANGELOG.
3. The drop happens on a major-version boundary (e.g., 2.0.0), not a minor.

Until then: when adding new public API, expose it from the real package AND add a shim here.
