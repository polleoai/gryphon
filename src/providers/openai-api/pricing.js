// Back-compat shim — see src/README.md.
// Real source: packages/provider-config/src/pricing/openai.js
//   (pricing tables moved into provider-config in v1.5.0 — they are
//    pure data/selection concerns, not runtime spawn logic.)
module.exports = require("../../../packages/provider-config/src/pricing/openai");
