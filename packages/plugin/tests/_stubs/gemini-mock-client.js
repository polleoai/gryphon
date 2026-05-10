/**
 * Mock Gemini client for unit tests.
 *
 * Mimics the @google/genai surface area Gryphon's GoogleProvider uses:
 *   client.models.generateContentStream({...}) → AsyncGenerator<chunk>
 *
 * Each test scripts the responses via `client.queueResponse({ chunks, error? })`:
 *   chunks: array of GenerateContentResponse-shaped objects to yield in order.
 *   error: throw this from the generator if set (after yielding any chunks).
 *
 * Gemini's chunk shape (per @google/genai types):
 *   {
 *     candidates: [{
 *       content: { parts: [...] },     // parts: { text } | { functionCall } | { functionResponse }
 *       finishReason?: string,
 *     }],
 *     usageMetadata?: { promptTokenCount, candidatesTokenCount, cachedContentTokenCount },
 *   }
 *
 * Helper builders:
 *   textChunk(text, finishReason?)  — { candidates: [{ content: { parts: [{ text }] }, ... }] }
 *   functionCallChunk(name, args, id?)
 *   usageChunk(usage)
 */

class MockClient {
  constructor() {
    this._scripts = [];
    this._calls = [];
    this.models = {
      generateContentStream: async (params) => {
        this._calls.push(params);
        if (this._scripts.length === 0) {
          throw new Error("MockClient (gemini): no queued response — call queueResponse first");
        }
        const script = this._scripts.shift();
        return makeAsyncGenerator(script);
      },
      generateContent: async (params) => {
        this._calls.push(params);
        if (this._scripts.length === 0) return { id: "mock-noop" };
        const script = this._scripts.shift();
        if (script.error) throw script.error;
        return script.completion || { id: "mock" };
      },
    };
  }

  queueResponse(script) {
    this._scripts.push(script);
  }

  get callCount() { return this._calls.length; }
  get calls() { return this._calls; }
}

async function* makeAsyncGenerator(script) {
  for (const chunk of script.chunks || []) {
    yield chunk;
  }
  if (script.error) throw script.error;
}

// ---------- helper builders ----------

function textChunk(text, finishReason) {
  return {
    candidates: [{
      content: { parts: [{ text }] },
      ...(finishReason ? { finishReason } : {}),
    }],
  };
}

function functionCallChunk(name, args, id) {
  const fc = { name, args };
  if (id) fc.id = id;
  return {
    candidates: [{
      content: { parts: [{ functionCall: fc }] },
      finishReason: "STOP",
    }],
  };
}

function usageChunk(usage) {
  return { usageMetadata: usage };
}

module.exports = {
  MockClient,
  textChunk,
  functionCallChunk,
  usageChunk,
};
