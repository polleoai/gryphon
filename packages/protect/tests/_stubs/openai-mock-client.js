/**
 * Mock OpenAI client for unit tests.
 *
 * Mimics the surface area Gryphon's OpenAIProvider + tool-loop exercise:
 *   client.chat.completions.stream({...}) → MockStream
 *
 * MockStream is a tiny EventEmitter-like object that supports the events
 * Gryphon listens on (`content`, `error`) and the awaited methods
 * (`finalChatCompletion()`, `abort()`). Each test scripts the responses
 * via `client.queueResponse({ chunks, completion })`.
 *
 * Per-stream script:
 *   chunks: array of strings (text deltas — emitted as `content` events)
 *   completion: the ChatCompletion object the stream resolves with
 *               (caller-specified so tests can validate finish_reason,
 *               tool_calls, usage, etc.)
 *
 * The mock fires `content` events synchronously inside `finalChatCompletion()`
 * BEFORE resolving, so the test sees the full event ordering before it
 * assertions runs.
 */

class MockStream {
  constructor(script) {
    this.script = script;
    this.listeners = {};
    this._aborted = false;
  }

  on(event, fn) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(fn);
    return this;
  }

  emit(event, ...args) {
    const fns = this.listeners[event] || [];
    for (const fn of fns) fn(...args);
  }

  abort() {
    this._aborted = true;
  }

  async finalChatCompletion() {
    // Emit text deltas in order. The real OpenAI stream emits (delta, snapshot);
    // we cumulate snapshots deterministically for tests.
    let snapshot = "";
    for (const delta of this.script.chunks || []) {
      if (this._aborted) {
        const err = new Error("Stream aborted");
        err.name = "APIUserAbortError";
        throw err;
      }
      snapshot += delta;
      this.emit("content", delta, snapshot);
    }

    if (this.script.error) {
      this.emit("error", this.script.error);
      throw this.script.error;
    }

    return this.script.completion;
  }
}

class MockClient {
  constructor() {
    this._scripts = [];
    this._calls = [];
    this.chat = {
      completions: {
        stream: (params) => {
          this._calls.push(params);
          if (this._scripts.length === 0) {
            throw new Error("MockClient: no queued response — call queueResponse first");
          }
          const script = this._scripts.shift();
          return new MockStream(script);
        },
        create: async (params) => {
          // for testApiKey() — non-streaming path
          this._calls.push(params);
          if (this._scripts.length === 0) return { id: "mock-noop" };
          const script = this._scripts.shift();
          if (script.error) throw script.error;
          return script.completion || { id: "mock" };
        },
      },
    };
  }

  queueResponse(script) {
    this._scripts.push(script);
  }

  // Test inspection
  get callCount() { return this._calls.length; }
  get calls() { return this._calls; }
}

module.exports = { MockClient, MockStream };
