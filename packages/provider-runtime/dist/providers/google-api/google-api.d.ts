/**
 * GoogleProvider — implements the LLMProvider contract via the official
 * `@google/genai` npm SDK (Gemini API).
 *
 * Stage 3 — second hand-built non-Anthropic adapter. Mirrors the structure
 * of OpenAIProvider deliberately so the chat-view doesn't need provider-
 * specific branches.
 *
 * The Gemini API is stateless (chat history must be replayed each turn).
 * Streaming uses `client.models.generateContentStream(...)` which returns
 * an async generator of GenerateContentResponse chunks; the provider
 * forwards accumulated text snapshots through onMessage(text, "replace").
 *
 * Tool support lives in `tool-loop.js`. The provider's `send` delegates
 * to `runGeminiToolLoop`, which speaks Gemini's functionCall/functionResponse
 * shape but reuses Gryphon's existing tool registry — security parity.
 *
 * Cost calculation: SDK reports promptTokenCount / candidatesTokenCount /
 * cachedContentTokenCount; pricing.js computeCost() converts to USD.
 */
export {};
