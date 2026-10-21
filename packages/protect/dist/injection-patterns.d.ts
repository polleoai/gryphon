/**
 * Injection-marker regex catalog (v0.6.0 Stage 5).
 *
 * Shared by:
 *   - the PostToolUse hook (posttool.js) — scans framed tool output for
 *     patterns and emits telemetry events when hits occur
 *   - the UserPromptSubmit hook (user-prompt.js, Stage 7) — scans pasted
 *     content for the same patterns and adds a cautionary `additionalContext`
 *
 * Design scope
 * ------------
 * These regexes are STRICT POSITIVES. They're optimised for high precision
 * on short, attacker-authored prompt-injection snippets. They are NOT
 * designed to catch every possible jailbreak or adversarial text — that's
 * an arms race and a full content-moderation product. A missed pattern
 * doesn't mean the framing (L1) doesn't protect the user: framing alone
 * tells Claude "this is data, not instructions," which covers the common
 * case even for content that bypasses our regexes.
 *
 * Each entry has:
 *   - id:       short stable key used in telemetry events
 *   - regex:    compiled pattern. Case-insensitive, multiline.
 *   - severity: "high" | "medium" — rough buckets for event aggregation
 *
 * Add with care. Every regex is run against every framed tool output, so
 * bad patterns pay a per-byte cost across the whole session.
 */
declare const INJECTION_PATTERNS: {
    id: string;
    regex: RegExp;
    severity: string;
}[];
declare const SCAN_MAX_BYTES: number;
/**
 * Scan a string for injection patterns. Returns an array of hit
 * descriptors (empty if none). Short-circuits after SCAN_MAX_BYTES of
 * input so a pathological 50MB output doesn't hang the hook.
 *
 * Each hit has:
 *   - id:       pattern id
 *   - severity: copied from pattern
 *   - match:    the literal matched substring (clipped to 160 chars)
 *   - offset:   0-based offset of the match in the scanned prefix
 */
declare function scanForInjectionMarkers(text: string): Array<{
    id: string;
    severity: string;
    match: string;
    offset: number;
}>;
export { INJECTION_PATTERNS, SCAN_MAX_BYTES, scanForInjectionMarkers, };
