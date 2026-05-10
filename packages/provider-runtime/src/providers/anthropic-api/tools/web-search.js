/**
 * WebSearch tool — search the web via Brave Search API.
 *
 * Anthropic's first-party web search isn't exposed through the API, so
 * Anthropic API mode integrates with a third-party provider. Brave is the default:
 *   - Has a generous free tier (2000 queries/month)
 *   - Privacy-focused (no tracking, no Google logins)
 *   - Simple REST API (one auth header, JSON response)
 *
 * The user supplies their own Brave API key via plugin settings; the
 * tool gracefully degrades to an instructive error when no key is set
 * (rather than failing silently or pretending to search).
 *
 * Permission: read-only network. Refused only in plan mode.
 */

const SCHEMA = {
  name: "WebSearch",
  description:
    "Searches the web and returns ranked results with title, URL, and " +
    "snippet for each. Use this to find current information that isn't " +
    "in your training data, or to discover URLs you can then WebFetch.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query. Be specific — search engines don't read minds.",
      },
      max_results: {
        type: "integer",
        description: "Number of results to return (1-20). Default 10.",
      },
    },
    required: ["query"],
  },
};

// See web-fetch.js for why we use Obsidian's requestUrl rather than
// fetch or undici: the renderer's fetch is CORS-restricted, and undici
// breaks on browser-style timers in Obsidian's Electron. requestUrl
// runs in the main process and works reliably. Wrapped in try/catch so
// unit tests that import this module in a plain Node context don't
// crash on the unresolved 'obsidian' require.
let requestUrl;
try { ({ requestUrl } = require("obsidian")); } catch (_) { /* test context */ }

const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const REQUEST_TIMEOUT_MS = 15_000;

async function execute(input, ctx) {
  const query = input.query;
  const maxResults = Math.min(20, Math.max(1, parseInt(input.max_results || 10, 10)));

  if (typeof query !== "string" || !query.trim()) {
    return _error("Missing or empty parameter: query");
  }

  if (ctx.permissionMode === "plan") {
    return _error(
      `Plan mode is active — WebSearch is not permitted. Describe the ` +
      `query you would run instead, or ask the user to switch modes.`
    );
  }

  const apiKey = (ctx.plugin && ctx.plugin.settings && ctx.plugin.settings.braveSearchApiKey) || "";
  if (!apiKey) {
    return _error(
      `Brave Search API key not configured. SDK-mode WebSearch requires ` +
      `a free Brave API key. Get one at https://brave.com/search/api/ and ` +
      `paste it into Settings → Gryphon → Brave Search API key. Until then, ` +
      `WebSearch is unavailable in Anthropic API mode (Claude Code mode uses Anthropic's ` +
      `built-in search and works without a Brave key).`
    );
  }

  const url = new URL(BRAVE_ENDPOINT);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(maxResults));

  // requestUrl doesn't support AbortSignal; enforce timeout via race.
  const timeoutError = new Error(`Brave Search timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(timeoutError), REQUEST_TIMEOUT_MS);
  });

  let response;
  try {
    response = await Promise.race([
      requestUrl({
        url: url.toString(),
        method: "GET",
        headers: {
          "Accept": "application/json",
          "X-Subscription-Token": apiKey,
        },
        throw: false,
      }),
      timeoutPromise,
    ]);
  } catch (e) {
    if (e === timeoutError) return _error(timeoutError.message);
    return _error(`Brave Search request failed: ${e.message}`);
  }

  if (response.status === 401 || response.status === 403) {
    return _error(`Brave Search rejected the API key (HTTP ${response.status}). Check Settings → Gryphon → Brave Search API key.`);
  }
  if (response.status === 429) {
    return _error("Brave Search rate-limited. Wait a moment and retry, or check your monthly quota at brave.com/search/api/dashboard.");
  }
  if (response.status < 200 || response.status >= 300) {
    return _error(`Brave Search returned HTTP ${response.status}`);
  }

  // requestUrl provides `.json` (parsed) and `.text` (raw) directly — no
  // separate .json() / .text() calls needed (those are standard fetch).
  let body = response.json;
  if (!body && typeof response.text === "string") {
    try { body = JSON.parse(response.text); }
    catch (e) { return _error(`Brave Search returned non-JSON response: ${e.message}`); }
  }
  if (!body || typeof body !== "object") {
    return _error("Brave Search returned empty or non-JSON response");
  }

  const results = (body.web && body.web.results) || [];
  if (results.length === 0) {
    return _ok(`No results for "${query}".`);
  }

  const formatted = results.slice(0, maxResults).map((r, i) => {
    const title = r.title || "(no title)";
    const url = r.url || "";
    const snippet = (r.description || "").replace(/\s+/g, " ").trim();
    return `${i + 1}. ${title}\n   ${url}\n   ${snippet}`;
  });

  return _ok(
    `Top ${formatted.length} results for "${query}":\n\n` +
    formatted.join("\n\n")
  );
}

function _ok(text) {
  return { content: [{ type: "text", text }], isError: false };
}

function _error(text) {
  return { content: [{ type: "text", text: `Error: ${text}` }], isError: true };
}

module.exports = { SCHEMA, execute };
