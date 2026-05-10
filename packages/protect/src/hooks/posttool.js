#!/usr/bin/env node
/**
 * PostToolUse hook (v0.6.0 Stage 5).
 *
 * Responsibilities:
 *   L1 — emit `additionalContext` framing for tool outputs whose
 *        content should be treated as data (WebFetch/WebSearch, Bash
 *        stdout, Glob/Grep results, out-of-vault Read). Edit/Write
 *        output is confirmation text and goes through untouched.
 *   L2 — scan framed content for prompt-injection markers and emit a
 *        telemetry event per hit via the IPC `event` request. Hits
 *        also sharpen the framing wording so Claude sees the warning.
 *
 * Fail-open (design invariant #3 contrast with PreToolUse):
 *   Framing loss is acceptable. Any parse/IPC/scan error results in
 *   an empty `{}` stdout — CC proceeds without framing this one call.
 *   The L3 action gate already protected the action side.
 *
 * Provenance-store interactions (Stage 6) are stubbed here — the Read
 * branch currently frames all Reads as a conservative default. Stage 6
 * narrows this to out-of-vault + tagged in-vault files.
 */

const path = require("path");
const fs = require("fs");

const {
  readStdinJson,
  writeStdoutJson,
  emitEvent,
  sendToGryphon,
  traceHook,
} = require("./common/ipc-client");

// Short timeout for provenance IPC calls — they're small, in-memory,
// no modal. A slow provenance lookup is much worse than silently
// skipping the lookup (fail-open for PostToolUse).
const PROVENANCE_TIMEOUT_MS = 2000;

// Crude detector for "this Bash command touched the network". Used to
// tag cwd-level provenance when a user runs `curl > file.txt` / `wget`
// / `nc`. False positives here are cheap (over-tagging just adds a
// framing notice); false negatives (missed network commands) leave
// gaps that per-file provenance is designed to cover.
const NETWORK_BASH_RE =
  /\b(curl|wget|nc|ncat|ssh|scp|rsync|git\s+clone|git\s+pull|git\s+fetch)\b/i;

// Hook scripts are standalone — no imports from main.js. The two
// modules below are source-of-truth'd in `packages/protect/src/`
// (Anthropic API mode also imports them from there); build.js copies them
// into `hooks/common/` alongside ipc-client at build time so the hook
// runtime can load them via `./common/...` without needing to know
// about the SDK path.
let scanForInjectionMarkers;
let buildFraming;
let shouldFrame;
try {
  // Built plugin layout: hooks/common/ contains the shared modules.
  ({ scanForInjectionMarkers } = require("./common/injection-patterns"));
  ({ buildFraming, shouldFrame } = require("./common/untrusted-framing"));
} catch (_) {
  try {
    // Source-tree layout (tests spawn from packages/protect/src/hooks/):
    // the modules live one level up. Same files, different path.
    ({ scanForInjectionMarkers } = require("../injection-patterns"));
    ({ buildFraming, shouldFrame } = require("../untrusted-framing"));
  } catch (_) {
    // Neither path — fail-open (framing becomes a no-op). Hook still
    // drains stdin and emits `{}` so CC's contract holds. Surface this
    // once to stderr so a missing build step (hooks/common/* not copied)
    // doesn't hide as "tool outputs aren't being scanned" in production.
    console.error("[gryphon/posttool] injection scanner + framing unavailable — tool output scanning disabled (both candidate require paths failed)");
  }
}

async function main() {
  let input = null;
  try {
    input = await readStdinJson();
  } catch (_) {
    await writeStdoutJson({});
    process.exit(0);
    return;
  }
  traceHook("PostToolUse", input);

  const toolName = input && input.tool_name;
  const toolResponse = input && input.tool_response;
  const toolInput = input && input.tool_input;
  const sessionId = input && input.session_id;
  const cwd = input && input.cwd;

  // If shared modules failed to load or we don't have what we need,
  // emit empty and exit. Fail-open per design invariant #3.
  if (!shouldFrame || !buildFraming || typeof toolName !== "string") {
    await writeStdoutJson({});
    process.exit(0);
    return;
  }

  // STAGE 6 + v0.6.0 sourceUrl polish: provenance side-effects FIRST,
  // before the framing decision. Each mark now carries the ORIGIN
  // (URL for WebFetch, query for WebSearch, command for Bash-network)
  // so later Writes in the same session can inherit that attribution
  // into their persistent tag. Without it, a tagged file gets a
  // generic "Write-after-WebFetch" label and we lose audit traceability
  // when a specific URL later proves problematic.
  let sourceAttribution = null;  // overrides framing source if non-null
  try {
    if (toolName === "WebFetch") {
      await sendToGryphon(
        {
          req: "provenance_mark",
          sessionId,
          flag: "untrustedContentActive",
          sourceTool: "WebFetch",
          sourceUrl: (toolInput && toolInput.url) || null,
        },
        { timeoutMs: PROVENANCE_TIMEOUT_MS },
      );
    } else if (toolName === "WebSearch") {
      await sendToGryphon(
        {
          req: "provenance_mark",
          sessionId,
          flag: "untrustedContentActive",
          sourceTool: "WebSearch",
          sourceQuery: (toolInput && toolInput.query) || null,
        },
        { timeoutMs: PROVENANCE_TIMEOUT_MS },
      );
    } else if (toolName === "Write") {
      // Tag the destination if the session is currently untrusted-active.
      // The URL / command that caused the session to go untrusted was
      // stashed by provenance_mark on sessionFlags.lastUntrustedSource.
      const checkResp = await sendToGryphon(
        { req: "provenance_check", path: toolInput && toolInput.file_path, cwd, sessionId },
        { timeoutMs: PROVENANCE_TIMEOUT_MS },
      );
      const sessFlags = checkResp && checkResp.sessionFlags;
      if (sessFlags && sessFlags.untrustedContentActive && toolInput && toolInput.file_path) {
        const lastSrc = sessFlags.lastUntrustedSource || {};
        const sourceLabel = lastSrc.tool
          ? `Write-after-${lastSrc.tool}`
          : "Write-after-untrusted";
        // Fold sourceQuery into sourceCommand shape for a single
        // downstream render path in untrusted-framing.js.
        const sourceCommand =
          lastSrc.sourceCommand ||
          (lastSrc.sourceQuery ? `web search for "${lastSrc.sourceQuery}"` : null);
        await sendToGryphon(
          {
            req: "provenance_add",
            path: toolInput.file_path,
            cwd,
            sessionId,
            source: sourceLabel,
            sourceUrl: lastSrc.sourceUrl || null,
            sourceCommand,
          },
          { timeoutMs: PROVENANCE_TIMEOUT_MS },
        );
      }
    } else if (toolName === "Bash" && toolInput && typeof toolInput.command === "string") {
      if (NETWORK_BASH_RE.test(toolInput.command)) {
        await sendToGryphon(
          {
            req: "provenance_mark",
            sessionId,
            flag: "untrustedContentActive",
            sourceTool: "Bash-network",
            sourceCommand: toolInput.command.length > 200
              ? toolInput.command.slice(0, 197) + "..."
              : toolInput.command,
          },
          { timeoutMs: PROVENANCE_TIMEOUT_MS },
        );
      }
    }
  } catch (_) { /* fail-open — provenance loss this turn is tolerable */ }

  // Framing decision: Read goes through provenance + vault-boundary
  // rules; everything else uses shouldFrame. Read of an in-vault file
  // is framed only if it's tagged in the provenance store (so an
  // imported web page produces framing on subsequent re-reads,
  // surviving plugin reload).
  if (toolName === "Read") {
    const filePath = toolInput && toolInput.file_path;
    const isOutside = _isOutsideVault(filePath, cwd);
    let isTagged = false;
    let tagMetadata = null;
    if (!isOutside) {
      try {
        const checkResp = await sendToGryphon(
          { req: "provenance_check", path: filePath, cwd, sessionId },
          { timeoutMs: PROVENANCE_TIMEOUT_MS },
        );
        isTagged = !!(checkResp && checkResp.tagged);
        tagMetadata = checkResp && checkResp.metadata;
      } catch (_) { /* fail-open */ }
    }
    if (!isOutside && !isTagged) {
      await writeStdoutJson({});
      process.exit(0);
      return;
    }
    if (isTagged && tagMetadata) {
      // Use the original provenance source as attribution rather than
      // the file_path — tells Claude the file is, e.g., "previously
      // fetched from https://example.com" instead of just "Read of
      // ./notes/x.md".
      sourceAttribution =
        tagMetadata.sourceUrl ? `previously fetched from ${tagMetadata.sourceUrl}` :
        tagMetadata.sourceCommand ? `result of: ${tagMetadata.sourceCommand}` :
        `tagged source: ${tagMetadata.source}`;
    }
  } else if (!shouldFrame(toolName)) {
    // Edit, Write, or unknown tool — no framing.
    await writeStdoutJson({});
    process.exit(0);
    return;
  }

  // Extract the scannable text portion of tool_response. Shape varies
  // per tool — Bash gives us an object with stdout/stderr fields;
  // WebFetch typically hands us a string body. We try the most common
  // shapes in order.
  const scannable = _extractScannableText(toolResponse);
  const sourceDetail = sourceAttribution || _summarizeSource(toolName, toolInput);

  let hits = [];
  if (scannable && typeof scanForInjectionMarkers === "function") {
    try {
      hits = scanForInjectionMarkers(scannable);
    } catch (e) {
      // Fail-open is intentional, but log so a recurring scanner crash
      // doesn't masquerade as "all tool outputs are clean."
      console.error("[gryphon/posttool] scanForInjectionMarkers threw:", e && e.message);
    }
  }

  // L2 telemetry: fire-and-forget event per hit. emitEvent swallows
  // errors so a missing IPC server never blocks the framing step.
  for (const hit of hits) {
    // No await — we don't want a slow IPC sink to delay framing. The
    // hook process exits once main() returns; best-effort is fine.
    emitEvent("regex-hit", {
      tool: toolName,
      patternId: hit.id,
      severity: hit.severity,
      sessionId: input.session_id || null,
    });
  }

  const framing = buildFraming({
    tool: toolName,
    sourceDetail,
    injectionHits: hits,
  });

  await writeStdoutJson({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: framing,
    },
  });
  process.exit(0);
}

/**
 * Pull the most-likely-attacker-authored text out of a tool_response.
 * We intentionally don't stringify the whole object — we just want the
 * content fields. Anything we miss just means we don't scan/frame
 * that particular shape, which is fail-open.
 */
function _extractScannableText(response) {
  if (typeof response === "string") return response;
  if (!response || typeof response !== "object") return "";
  // Bash shape: { stdout, stderr, interrupted, isImage, noOutputExpected }
  if (typeof response.stdout === "string" || typeof response.stderr === "string") {
    return [response.stdout, response.stderr].filter(Boolean).join("\n");
  }
  // WebFetch sometimes: { content: "...", ... }; sometimes plain string above
  if (typeof response.content === "string") return response.content;
  if (typeof response.result === "string") return response.result;
  if (typeof response.output === "string") return response.output;
  // Fallback: attempt a JSON stringify for the scan. Cap to keep hook
  // latency bounded; the scanner itself will further cap at its budget.
  try {
    const s = JSON.stringify(response);
    return s.length > 64 * 1024 ? s.slice(0, 64 * 1024) : s;
  } catch (_) {
    return "";
  }
}

/**
 * Short source attribution for the framing string. Keeps the `tool`
 * context lean so the framing stays ~150 bytes.
 */
function _summarizeSource(tool, input) {
  if (!input) return null;
  if (tool === "WebFetch") return input.url || null;
  if (tool === "WebSearch") return input.query ? `query: ${input.query}` : null;
  if (tool === "Bash") return typeof input.command === "string" ? `cmd: ${input.command}` : null;
  if (tool === "Read") return input.file_path || null;
  if (tool === "Glob") return input.pattern || null;
  if (tool === "Grep") return input.pattern ? `pattern: ${input.pattern}` : null;
  return null;
}

/**
 * Vault-boundary check for Read framing. An absolute path outside the
 * vault root — or a path that would resolve outside via `..` — is
 * "outside". A path that's relative and resolves inside is "inside".
 *
 * Fail-closed here (err on the side of framing) because misclassifying
 * an outside path as inside leaves framing off where it should be on,
 * which is exactly the gap the design warns against.
 */
function _isOutsideVault(filePath, vaultRoot) {
  if (typeof filePath !== "string" || typeof vaultRoot !== "string") {
    return true;  // unknown → frame it
  }
  // Round-12 F10 canonicalized `..`; Round-14 Q1 adds symlink resolution.
  // path.resolve is LEXICAL and doesn't follow symlinks, so a symlink
  // `/vault/link.txt → /outside/secret.txt` would pass the prefix check
  // and bypass framing. fs.realpathSync follows symlinks — use it when
  // the file exists; fall back to path.resolve (writes to new paths,
  // outside-vault paths that can't be stat'd, etc).
  const lexical = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(vaultRoot, filePath);
  let resolved;
  try { resolved = fs.realpathSync(lexical); }
  catch (_) { resolved = lexical; }
  let normalizedRoot;
  try { normalizedRoot = fs.realpathSync(path.resolve(vaultRoot)); }
  catch (_) { normalizedRoot = path.resolve(vaultRoot); }
  return !resolved.startsWith(normalizedRoot + path.sep) && resolved !== normalizedRoot;
}

main().catch(async () => {
  // Fail-open: even on a main() throw, emit empty rather than a stray
  // deny. PostToolUse isn't load-bearing for safety; framing loss is
  // tolerable per design invariant #3.
  try { await writeStdoutJson({}); } catch (_) { /* ignore */ }
  process.exit(0);
});
