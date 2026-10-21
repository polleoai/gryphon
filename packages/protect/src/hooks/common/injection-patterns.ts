// Source-tree twin of the shipped hooks/common/injection-patterns.js.
// build.ts builds that file from src/injection-patterns.ts; this re-export
// gives the hook scripts the same `./common/…` path when they run from the
// source tree (tests). It is never shipped.
export { scanForInjectionMarkers } from "../../injection-patterns";
