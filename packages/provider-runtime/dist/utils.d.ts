/**
 * Shared utilities for the Gryphon plugin.
 *
 *   findClaudeBinary     — Locate the `claude` CLI the user already installed
 *   findNodeBinary       — Locate a real `node` binary for hook scripts to run
 *   buildEnhancedPath    — PATH env with common binary locations prepended
 *   detectFlatpakSandbox — Detect if Obsidian is running inside Flatpak
 *
 * The discovery helpers are cache-aware so callers can hit them repeatedly
 * without paying shell-spawn costs. `clearBinaryDiscoveryCache()` is the
 * escape hatch for a "re-detect" button or a settings-reload flow.
 */
export {};
