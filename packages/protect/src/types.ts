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

// ── Category discriminant ─────────────────────────────────────────────────
// Values are the real `category:` strings used in constants.js and
// attack-detector.js. Keep in sync with PROTECTED_CATEGORIES in constants.ts.

export type ProtectCategory =
  | "modifies-gryphon"
  | "modifies-editor"
  | "runs-arbitrary-code"
  | "escalates-privileges"
  | "accesses-system"
  | "persistent-execution"
  | "destructive-operation"
  | "network-exec"
  | "network-fetch"
  | "user-custom";

// ── classify() return shape ───────────────────────────────────────────────
// null  → no protected pattern matched; gate() treats the call as ordinary.
// object → one of the user's flagged patterns matched; gate() fires the
//           protected-operation modal (overrides Safe/YOLO).
//
// Real field names from attack-detector.js lines 227-239, 280-292.

export type ClassifyVerdict = {
  tool: string;
  matchedPattern: string;
  category: ProtectCategory | string; // |string for forward-compat user-custom strings
  title: string;
  userRisk: string;
  technicalDetail: string;
} | null;

// ── assertNever ───────────────────────────────────────────────────────────
// Use at the bottom of an exhaustive switch over ProtectCategory to make
// TypeScript flag unhandled arms at compile time.

export function assertNever(x: never): never {
  throw new Error(`Unhandled ProtectCategory: ${JSON.stringify(x)}`);
}

// ── ProtectedCommand ──────────────────────────────────────────────────────
// Real shape of entries in DEFAULT_PROTECTED_COMMANDS (constants.js).
// `platforms` is optional — missing means "show on every host".

export interface ProtectedCommand {
  pattern: string;
  category: ProtectCategory | string;
  userRisk: string;
  explanation: string;
  platforms?: string[];
}

// ── ProtectedPath ─────────────────────────────────────────────────────────
// Real shape of entries in DEFAULT_PROTECTED_PATHS (constants.js).

export interface ProtectedPath {
  pattern: string;
  category: ProtectCategory | string;
  userRisk: string;
  explanation: string;
}

// ── IPC protocol frames ───────────────────────────────────────────────────
// Line-delimited JSON protocol: client sends IpcRequest, server replies
// with IpcResponse.  Real field names from permission-ipc-server.js lines
// 9-13, 359-388.

export interface IpcRequest {
  req: string;
  id: unknown; // uuid string in practice; typed loosely to match runtime
  [k: string]: unknown;
}

export interface IpcResponse {
  resp: string;
  id: unknown;
  [k: string]: unknown;
}
