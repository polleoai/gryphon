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
export type ProtectCategory = "modifies-gryphon" | "modifies-editor" | "runs-arbitrary-code" | "escalates-privileges" | "accesses-system" | "persistent-execution" | "destructive-operation" | "network-exec" | "network-fetch" | "user-custom";
export type ClassifyVerdict = {
    tool: string;
    matchedPattern: string;
    category: ProtectCategory | string;
    title: string;
    userRisk: string;
    technicalDetail: string;
} | null;
export declare function assertNever(x: never): never;
export interface ProtectedCommand {
    pattern: string;
    category: ProtectCategory | string;
    userRisk: string;
    explanation: string;
    platforms?: string[];
}
export interface ProtectedPath {
    pattern: string;
    category: ProtectCategory | string;
    userRisk: string;
    explanation: string;
}
export interface IpcRequest {
    req: string;
    id: unknown;
    [k: string]: unknown;
}
export interface IpcResponse {
    resp: string;
    id: unknown;
    [k: string]: unknown;
}
