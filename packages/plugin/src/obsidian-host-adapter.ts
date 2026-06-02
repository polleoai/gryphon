/**
 * ObsidianHostAdapter — wraps Obsidian's Notice + requestUrl behind
 * the HostAdapter duck-type so runtime/protect can stay headless.
 *
 * The plugin instantiates one and passes it to createProvider() and
 * createProtectionContext() so internals never `require("obsidian")` directly.
 */

class ObsidianHostAdapter {
  notify(message, opts) {
    opts = opts || {};
    // opts.level (info|warn|error) is accepted for HostAdapter contract parity but
    // ignored — Obsidian's Notice has no severity surface. Headless paths route by
    // level via console.error/warn/log; here every notice renders identically.
    const { Notice } = require("obsidian");
    new Notice(message, opts.timeoutMs || 5000);
  }

  async fetch(url, opts) {
    opts = opts || {};
    const { requestUrl } = require("obsidian");
    const response = await requestUrl({
      url,
      method: opts.method || "GET",
      headers: opts.headers,
      body: opts.body,
      throw: false,
    });
    // Normalise to a fetch-like shape so callers can write provider-agnostic code.
    return {
      status: response.status,
      text: async () => response.text,
      json: async () => response.json,
    };
  }
}

module.exports = { ObsidianHostAdapter };
