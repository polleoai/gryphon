// Source-tree twin of the shipped hooks/common/untrusted-framing.js.
// build.ts builds that file from src/untrusted-framing.ts; this re-export
// gives the hook scripts the same `./common/…` path when they run from the
// source tree (tests). It is never shipped.
export { buildFraming, shouldFrame } from "../../untrusted-framing";
