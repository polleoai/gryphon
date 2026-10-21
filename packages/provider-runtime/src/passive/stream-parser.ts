// packages/provider-runtime/src/passive/stream-parser.ts
// PURE accumulator: feed parsed stream-json events; on `result` returns a
// finalized SendResponse-shaped object. Preserves tool_use structure
// (unlike ClaudeCodeProvider, which flattens content to text).
//
// See docs/superpowers/specs/2026-06-14-passive-backend-design.md §5.

import type { ContentBlock, PassiveUsage, StopReason } from "./types";

const VALID_STOP: ReadonlySet<unknown> = new Set(["end_turn", "tool_use", "max_tokens", "stop_sequence"]);

// Loose wire shapes of the claude stream-json events this parser reads.
interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface RawBlock {
  type?: string;
  text?: unknown;
  id: string;
  name: string;
  input: object;
}

interface RawEvent {
  type?: string;
  subtype?: unknown;
  session_id?: string;
  model?: string;
  message?: { content?: RawBlock[]; usage?: RawUsage };
  stop_reason?: string;
  is_error?: unknown;
  api_error_status?: unknown;
  usage?: RawUsage;
  total_cost_usd?: unknown;
}

/** A finalized turn, returned by `push` on a `result` event. */
interface PassiveTurnResult {
  content: ContentBlock[];
  stop_reason: StopReason;
  usage: PassiveUsage;
  total_cost_usd: number;
  sessionId: string;
  _resultError?: string | null;
}

function normalizeUsage(u: RawUsage | null | undefined): PassiveUsage {
  u = u || {};
  return {
    input_tokens: u.input_tokens || 0,
    output_tokens: u.output_tokens || 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
    cache_read_input_tokens: u.cache_read_input_tokens || 0,
  };
}

class PassiveStreamParser {
  declare sessionId: string | null;
  declare resolvedModel: string | null;
  declare _content: ContentBlock[];
  declare _lastUsage: RawUsage | null;
  constructor() {
    this.sessionId = null;
    this.resolvedModel = null;
    this._content = [];     // accumulated content blocks for this turn
    this._lastUsage = null; // from the last assistant message
  }

  // Returns a finalized response object on `result`, else null.
  push(rawEvent: unknown): PassiveTurnResult | null {
    if (!rawEvent || typeof rawEvent !== "object") return null;
    const raw = rawEvent as RawEvent;

    if (raw.type === "system" && raw.subtype === "init") {
      this.sessionId = raw.session_id || this.sessionId;
      if (raw.model) this.resolvedModel = raw.model;
      return null;
    }

    if (raw.type === "assistant" && raw.message && Array.isArray(raw.message.content)) {
      for (const block of raw.message.content) {
        if (block && block.type === "text" && typeof block.text === "string") {
          this._content.push({ type: "text", text: block.text });
        } else if (block && block.type === "tool_use") {
          this._content.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
        }
        // thinking / redacted_thinking intentionally dropped from passive output.
      }
      if (raw.message.usage) this._lastUsage = raw.message.usage;
      return null;
    }

    if (raw.type === "result") {
      const stop = VALID_STOP.has(raw.stop_reason) ? (raw.stop_reason as StopReason) : "end_turn";
      // C1: a CLI error result (is_error, error_* subtype, or api_error_status)
      // carries empty/partial content. Flag it so the session REJECTS rather
      // than laundering an API/runtime error into a fake successful turn.
      const errored =
        raw.is_error === true ||
        (typeof raw.subtype === "string" && raw.subtype !== "success") ||
        !!raw.api_error_status;
      const errorDetail = errored
        ? [raw.subtype, raw.api_error_status && `api_error_status=${JSON.stringify(raw.api_error_status)}`]
            .filter(Boolean).join(" ") || "error"
        : null;
      return {
        content: this._content.slice(),
        stop_reason: stop,
        usage: normalizeUsage(raw.usage || this._lastUsage),
        total_cost_usd: typeof raw.total_cost_usd === "number" ? raw.total_cost_usd : 0,
        sessionId: raw.session_id || this.sessionId || "",
        _resultError: errorDetail,
      };
    }

    return null; // stream_event deltas, tool_result echoes, rate_limit_event — ignored for the final shape
  }

  reset(): void {
    this._content = [];
    this._lastUsage = null;
  }
}

export { PassiveStreamParser };
export type { PassiveTurnResult };