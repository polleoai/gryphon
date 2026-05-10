// Back-compat shim — see src/README.md.
// Real source: packages/provider-runtime/src/utils.js
//   (utils moved out of the plugin shell into provider-runtime in v1.5.0
//    because findClaudeBinary / findCodexBinary / findGeminiBinary are
//    runtime-side concerns: provider implementations call them.)
module.exports = require("../packages/provider-runtime/src/utils");
