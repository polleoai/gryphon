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

const INJECTION_PATTERNS = [
  {
    id: "ignore-previous",
    regex: /\bignore\s+(all\s+)?(previous|prior|earlier|above|the\s+above)\s+(instructions|directions|prompts|rules|orders|messages)\b/i,
    severity: "high",
  },
  {
    id: "system-override",
    regex: /\b(new|updated|revised)\s+(system|admin|root)\s+(prompt|instruction|directive|message)\b/i,
    severity: "high",
  },
  {
    id: "role-override",
    regex: /\byou\s+are\s+(now|actually)\s+(a|an|the)\s+\w+/i,
    severity: "medium",
  },
  {
    id: "jailbreak-mode",
    regex: /\b(developer|debug|jailbreak|DAN)\s+mode\b/i,
    severity: "medium",
  },
  {
    id: "exfiltrate-file",
    regex: /\b(send|upload|post|forward|leak)\s+(the\s+)?(contents?|file|secrets?|keys?|tokens?|credentials?)\b/i,
    severity: "high",
  },
  {
    id: "fetch-and-pipe-shell",
    regex: /\b(curl|wget)\s+\S+\s*\|\s*(bash|sh|zsh|python\d?)\b/i,
    severity: "high",
  },
  {
    id: "api-key-mention",
    regex: /\b(anthropic|openai|claude|api)[-_]?(key|token|secret)\b/i,
    severity: "medium",
  },
  {
    id: "ssh-key-read",
    regex: /\b(cat|read|show)\s+[~\/]\S*\.ssh\/\S+/i,
    severity: "high",
  },
  {
    id: "cloud-metadata",
    regex: /(169\.254\.169\.254|metadata\.google\.internal|fd00:ec2::254)/i,
    severity: "high",
  },
];

// Scan budget — cap at ~256 KB to keep hook latency bounded even when
// a Bash command produces megabytes of stdout. Measured in characters
// (conservative proxy for UTF-8 bytes).
const SCAN_MAX_BYTES = 256 * 1024;

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
function scanForInjectionMarkers(text) {
  if (typeof text !== "string" || text.length === 0) return [];
  const scanText = text.length > SCAN_MAX_BYTES ? text.slice(0, SCAN_MAX_BYTES) : text;

  const hits = [];
  for (const pat of INJECTION_PATTERNS) {
    const m = pat.regex.exec(scanText);
    if (!m) continue;
    let snippet = m[0];
    if (snippet.length > 160) snippet = snippet.slice(0, 157) + "...";
    hits.push({
      id: pat.id,
      severity: pat.severity,
      match: snippet,
      offset: m.index,
    });
    pat.regex.lastIndex = 0;
  }
  return hits;
}

module.exports = {
  INJECTION_PATTERNS,
  SCAN_MAX_BYTES,
  scanForInjectionMarkers,
};
