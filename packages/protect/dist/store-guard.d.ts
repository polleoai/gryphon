type Bundle = {
    source: string;
    sha256: string;
};
type Ensured = {
    ok: true;
    path: string;
    sha256: string;
} | {
    ok: false;
    reason: string;
};
declare function storeGuardDir(): string;
declare function sweepStoreGuardScripts(keep: string, dir?: string, now?: number): void;
/**
 * Make sure the current store-guard script is on disk and intact. Rewrites
 * it (atomically: temp file in the same dir, then rename) when it's
 * missing, altered or replaced by a link, and reads it back to verify.
 * Never throws: `{ ok: false, reason }` means the caller runs without the
 * hook and must say so.
 */
declare function ensureStoreGuardScript(opts?: {
    bundle?: Bundle;
    dir?: string;
}): Ensured;
export { ensureStoreGuardScript, sweepStoreGuardScripts, storeGuardDir, };
