/**
 * ObsidianHostAdapter — wraps Obsidian's Notice + requestUrl behind
 * the HostAdapter duck-type so runtime/protect can stay headless.
 *
 * The plugin instantiates one and passes it to createProvider() and
 * createProtectionContext() so internals never `require("obsidian")` directly.
 */
export {};
