"use strict";
/**
 * Shared domain types for @gryphon/protect.
 *
 * G1 — The `ProtectCategory` union is the discriminant for `ClassifyVerdict`.
 *       Adding a new category must fail to compile until every switch
 *       that covers `ProtectCategory` handles the new branch.
 * G2 — `assertNever` closes each exhaustive switch so the compiler
 *       enforces completeness.
 *
 * These types model the REAL runtime shapes (grepped from attack-detector.js,
 * constants.js, and permission-ipc-server.js). They are additive — zero
 * runtime behavior is introduced or changed.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.assertNever = assertNever;
// ── assertNever ───────────────────────────────────────────────────────────
// Use at the bottom of an exhaustive switch over ProtectCategory to make
// TypeScript flag unhandled arms at compile time.
function assertNever(x) {
    throw new Error(`Unhandled ProtectCategory: ${JSON.stringify(x)}`);
}
