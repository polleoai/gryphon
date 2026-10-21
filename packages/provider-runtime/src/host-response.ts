/**
 * Read a host adapter's fetch response, whichever shape it has.
 *
 * ObsidianHostAdapter returns Obsidian's requestUrl shape — `text` (string) and
 * `json` (parsed) as properties. HeadlessHostAdapter (nodeFetch) and any
 * WHATWG-style fetch return `text()` / `json()` methods. Tools must handle
 * both, or a headless run reads an empty body as if the page were blank.
 */

interface HostBody {
  text?: unknown;
  json?: unknown;
  arrayBuffer?: unknown;
}

async function readText(res: HostBody): Promise<string> {
  if (typeof res.text === "string") return res.text;
  if (typeof res.text === "function") {
    const t: unknown = await (res.text as () => Promise<unknown>).call(res);
    if (typeof t === "string") return t;
  }
  if (res.arrayBuffer instanceof ArrayBuffer) return Buffer.from(res.arrayBuffer).toString("utf8");
  return "";
}

/** Parsed JSON body, or undefined when there is none or it doesn't parse. */
async function readJson(res: HostBody): Promise<unknown> {
  if (typeof res.json === "function") {
    try { return await (res.json as () => Promise<unknown>).call(res); } catch { return undefined; }
  }
  if (res.json !== undefined && res.json !== null) return res.json;
  const text = await readText(res);
  if (!text) return undefined;
  try { return JSON.parse(text) as unknown; } catch { return undefined; }
}

export { readText, readJson };
