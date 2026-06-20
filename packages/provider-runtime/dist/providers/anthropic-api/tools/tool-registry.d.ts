/**
 * Tool registry — single source of truth for SDK-mode tool schemas and
 * dispatchers.
 *
 * Tools register themselves by adding to TOOLS_BY_PHASE; the schemas
 * shipped to the API are derived from the active set, scoped by which
 * phases are enabled (read-only Phase 3, +write Phase 4, +bash/web
 * Phase 5). Permission-gated tools (Write/Edit/Bash) check the caller's
 * permissionMode in their execute() before performing the side effect.
 */
export {};
