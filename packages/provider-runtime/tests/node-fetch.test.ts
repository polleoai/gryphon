// nodeFetch: HeadlessHostAdapter's default fetch, on node's http/https/zlib.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const zlib = require("zlib");
const { nodeFetch } = require("../src/node-fetch");

function serve(handler: (req: any, res: any) => void): Promise<{ base: string; close: () => void; seen: any[] }> {
  const seen: any[] = [];
  const server = http.createServer((req: any, res: any) => {
    let body = "";
    req.on("data", (c: Buffer) => { body += c; });
    req.on("end", () => { seen.push({ method: req.method, url: req.url, headers: req.headers, body }); handler(req, res); });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    r({ base: `http://127.0.0.1:${port}`, close: () => server.close(), seen });
  }));
}

test("GET: status, lower-cased headers, text and json", async () => {
  const s = await serve((_req, res) => { res.writeHead(200, { "Content-Type": "application/json", "X-Multi": ["a", "b"] }); res.end('{"ok":true}'); });
  try {
    const r = await nodeFetch(`${s.base}/x`, { headers: { "X-Token": "t" } });
    assert.equal(r.status, 200);
    assert.equal(r.headers["content-type"], "application/json");
    assert.equal(r.headers["x-multi"], "a, b");
    assert.equal(await r.text(), '{"ok":true}');
    assert.deepEqual(await r.json(), { ok: true });
    assert.equal(s.seen[0].headers["x-token"], "t");
    assert.match(s.seen[0].headers["accept-encoding"], /gzip/);
  } finally { s.close(); }
});

test("non-2xx statuses resolve (no throw), like fetch", async () => {
  const s = await serve((_req, res) => { res.writeHead(403); res.end("nope"); });
  try {
    const r = await nodeFetch(`${s.base}/`);
    assert.equal(r.status, 403);
    assert.equal(await r.text(), "nope");
  } finally { s.close(); }
});

test("gzip, deflate and br bodies are decoded", async () => {
  const payload = "héllo ".repeat(50);
  for (const [enc, fn] of [["gzip", zlib.gzipSync], ["deflate", zlib.deflateSync], ["br", zlib.brotliCompressSync]] as const) {
    const s = await serve((_req, res) => { res.writeHead(200, { "Content-Encoding": enc }); res.end(fn(Buffer.from(payload))); });
    try { assert.equal(await (await nodeFetch(`${s.base}/`)).text(), payload, enc); } finally { s.close(); }
  }
});

test("redirects: followed; 303 → GET without body; 307 keeps method + body", async () => {
  const s = await serve((req, res) => {
    if (req.url === "/a") { res.writeHead(302, { Location: "/b" }); return res.end(); }
    if (req.url === "/p303") { res.writeHead(303, { Location: "/b" }); return res.end(); }
    if (req.url === "/p307") { res.writeHead(307, { Location: "/b" }); return res.end(); }
    res.writeHead(200); res.end(`${req.method}`);
  });
  try {
    assert.equal(await (await nodeFetch(`${s.base}/a`)).text(), "GET");
    assert.equal(await (await nodeFetch(`${s.base}/p303`, { method: "POST", body: "x", headers: { "Content-Type": "text/plain" } })).text(), "GET");
    assert.equal(s.seen[s.seen.length - 1].body, "");
    assert.equal(await (await nodeFetch(`${s.base}/p307`, { method: "POST", body: "y" })).text(), "POST");
    assert.equal(s.seen[s.seen.length - 1].body, "y");
  } finally { s.close(); }
});

test("a cross-origin redirect drops authorization / cookie, keeps other headers", async () => {
  const b = await serve((_req, res) => { res.writeHead(200); res.end("ok"); });
  const a = await serve((_req, res) => { res.writeHead(302, { Location: `${b.base}/landing` }); res.end(); });
  try {
    await nodeFetch(`${a.base}/`, { headers: { Authorization: "Bearer s3cret", Cookie: "c=1", "X-Subscription-Token": "k" } });
    const h = b.seen[0].headers;
    assert.equal(h.authorization, undefined);
    assert.equal(h.cookie, undefined);
    assert.equal(h["x-subscription-token"], "k");
  } finally { a.close(); b.close(); }
});

test("redirect loops stop at 20 hops", async () => {
  const s = await serve((_req, res) => { res.writeHead(302, { Location: "/loop" }); res.end(); });
  try {
    await assert.rejects(nodeFetch(`${s.base}/loop`), /redirect count exceeded/);
    assert.equal(s.seen.length, 21);
  } finally { s.close(); }
});

test("only http and https", async () => {
  await assert.rejects(nodeFetch("file:///etc/passwd"), /unsupported protocol file:/);
  await assert.rejects(nodeFetch("data:text/plain,hi"), /unsupported protocol data:/);
});

test("a decompression bomb is stopped at maxBytes, not buffered whole", async () => {
  const bomb = zlib.gzipSync(Buffer.alloc(20 * 1024 * 1024, 0x61)); // 20 MB of "a" → ~20 KB gzip
  const s = await serve((_req, res) => { res.writeHead(200, { "Content-Encoding": "gzip" }); res.end(bomb); });
  try {
    const before = process.memoryUsage().rss;
    await assert.rejects(nodeFetch(`${s.base}/`, { maxBytes: 1024 * 1024 }), /larger than 1048576 bytes/);
    assert.ok(process.memoryUsage().rss - before < 64 * 1024 * 1024, "did not inflate the whole body");
    // Within the cap the same body is fine.
    assert.equal((await (await nodeFetch(`${s.base}/`, { maxBytes: 32 * 1024 * 1024 })).text()).length, 20 * 1024 * 1024);
  } finally { s.close(); }
});

test("a corrupt gzip body rejects instead of hanging", async () => {
  const s = await serve((_req, res) => { res.writeHead(200, { "Content-Encoding": "gzip" }); res.end(Buffer.from("not gzip at all")); });
  try {
    await assert.rejects(nodeFetch(`${s.base}/`), /could not decode/);
  } finally { s.close(); }
});

test("empty bodies marked as encoded resolve empty (HEAD, 204, empty 200)", async () => {
  const s = await serve((req, res) => {
    if (req.url === "/204") { res.writeHead(204, { "Content-Encoding": "gzip" }); return res.end(); }
    res.writeHead(200, { "Content-Encoding": "gzip" }); res.end();
  });
  try {
    assert.equal(await (await nodeFetch(`${s.base}/x`, { method: "HEAD" })).text(), "");
    assert.equal((await nodeFetch(`${s.base}/204`)).status, 204);
    assert.equal(await (await nodeFetch(`${s.base}/empty`)).text(), "");
  } finally { s.close(); }
});

test("a silent server times out instead of hanging", async () => {
  const s = await serve(() => { /* never answers */ });
  try {
    await assert.rejects(nodeFetch(`${s.base}/`, { timeoutMs: 300 }), /timed out/);
  } finally { s.close(); }
});

test("hitting the cap stops the decoder (CPU bounded, not just memory)", async () => {
  const bomb = zlib.brotliCompressSync(Buffer.alloc(200 * 1024 * 1024, 0x61));
  const s = await serve((_req, res) => { res.writeHead(200, { "Content-Encoding": "br" }); res.end(bomb); });
  try {
    const t0 = process.cpuUsage();
    await assert.rejects(nodeFetch(`${s.base}/`, { maxBytes: 1024 * 1024 }), /larger than/);
    await new Promise((r) => setTimeout(r, 300)); // let any leftover decoding run
    const used = process.cpuUsage(t0);
    assert.ok((used.user + used.system) / 1000 < 1500, `decoder stopped (cpu ${(used.user + used.system) / 1000} ms)`);
  } finally { s.close(); }
});

// ── SSRF guard (blockAddress) — WebFetch passes web-fetch's _isPrivateHost ──
const { _isPrivateHost } = require("../src/providers/anthropic-api/tools/web-fetch");
const PRIVATE_URLS = [
  "http://127.0.0.1/", "http://2130706433/", "http://0x7f.1/", "http://017700000001/",
  "http://169.254.169.254/latest/meta-data/", "http://0.0.0.0/", "http://10.0.0.1/",
  "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://[fc00::1]/", "http://[fe80::1]/",
  "http://localhost/",
];

test("SSRF guard: private / loopback / metadata addresses refused as the FIRST request", async () => {
  for (const u of PRIVATE_URLS) {
    await assert.rejects(nodeFetch(u, { blockAddress: _isPrivateHost, timeoutMs: 2000 }), /refusing to connect/, u);
  }
});

test("SSRF guard: every private address refused as a REDIRECT target", async () => {
  let allowFirstHop = true;
  const block = (h: string) => (allowFirstHop ? false : _isPrivateHost(h));
  let target = "";
  const s = await serve((_req, res) => { allowFirstHop = false; res.writeHead(302, { Location: target }); res.end(); });
  try {
    for (const u of PRIVATE_URLS) {
      allowFirstHop = true;
      target = u;
      await assert.rejects(nodeFetch(`${s.base}/start`, { blockAddress: block, timeoutMs: 2000 }), /refusing to connect/, `redirect → ${u}`);
    }
  } finally { s.close(); }
});

test("SSRF guard: a hostname that RESOLVES to a private address is refused at connect time", async () => {
  // The name itself passes; the address DNS gives back doesn't (no rebinding window).
  const block = (h: string) => h === "127.0.0.1" || h === "::1";
  const s = await serve((_req, res) => { res.writeHead(200); res.end("internal"); });
  try {
    const port = new URL(s.base).port;
    await assert.rejects(nodeFetch(`http://localhost:${port}/`, { blockAddress: block, timeoutMs: 2000 }), (e: Error) => /resolves to a private or loopback address/.test(e.message) && !/127\.0\.0\.1|::1/.test(e.message));
    assert.equal(s.seen.length, 0, "no request reached the server");
  } finally { s.close(); }
});

test("SSRF guard off (other callers): a local server is reachable", async () => {
  const s = await serve((_req, res) => { res.writeHead(200); res.end("ok"); });
  try { assert.equal(await (await nodeFetch(`${s.base}/`)).text(), "ok"); } finally { s.close(); }
});

test("SSRF guard: an unguarded caller's keep-alive socket can't carry a guarded request inside", async () => {
  // localhost. (trailing dot) passes the name check; only the connect-time
  // lookup sees it resolve to loopback. A pooled socket would skip that lookup.
  const s = await serve((_req, res) => { res.writeHead(200, { Connection: "keep-alive" }); res.end("INTERNAL SECRET"); });
  try {
    const port = new URL(s.base).port;
    const url = `http://localhost.:${port}/x`;
    await assert.rejects(nodeFetch(url, { blockAddress: _isPrivateHost, timeoutMs: 2000 }), /refusing to connect/);
    assert.equal(await (await nodeFetch(url)).text(), "INTERNAL SECRET"); // unguarded caller: socket now pooled
    await assert.rejects(nodeFetch(url, { blockAddress: _isPrivateHost, timeoutMs: 2000 }), /refusing to connect/);
    assert.equal(s.seen.length, 1, "only the unguarded request reached the server");
  } finally { s.close(); }
});

// ── proxy (#40: WebFetch in Obsidian now goes through nodeFetch) ──────
const { proxyFromEnv } = require("../src/node-fetch");
const LOCAL_LITERAL = /^(127\.0\.0\.1|\[::1\])$/;

test("proxyFromEnv: scheme-specific vars, all_proxy fallback, NO_PROXY forms", () => {
  const p = proxyFromEnv({ HTTPS_PROXY: "http://p:3128", http_proxy: "http://h:8080", NO_PROXY: "internal.corp, .example.com,*.test,10.1.2.3,[::1],api.local:8443" });
  assert.equal(p(new URL("https://a.org/")), "http://p:3128");
  assert.equal(p(new URL("http://a.org/")), "http://h:8080");
  for (const u of ["https://internal.corp/", "https://x.example.com/", "https://example.com/", "https://y.test/", "http://10.1.2.3/", "http://[::1]/", "https://api.local:8443/"]) {
    assert.equal(p(new URL(u)), null, u);
  }
  assert.equal(p(new URL("https://api.local/")), "http://p:3128", "port-qualified entry only matches that port");
  assert.equal(p(new URL("https://notexample.com/")), "http://p:3128", "suffix match is on a dot boundary");
  assert.equal(proxyFromEnv({ ALL_PROXY: "http://all:1" })(new URL("https://a.org/")), "http://all:1");
  assert.equal(proxyFromEnv({ HTTPS_PROXY: "http://p:1", NO_PROXY: "*" })(new URL("https://a.org/")), null);
  assert.equal(proxyFromEnv({ HTTPS_PROXY: "  " })(new URL("https://a.org/")), null, "blank means unset");
  assert.equal(proxyFromEnv({})(new URL("https://a.org/")), null);
});

test("proxy, guarded http: the proxy is sent the CHECKED address, with the real Host header", async () => {
  const proxy = await serve((_req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end("via proxy"); });
  try {
    const r = await nodeFetch("http://localhost:8099/x?y=1", { blockAddress: () => false, proxyFor: () => proxy.base, timeoutMs: 2000 });
    assert.equal(await r.text(), "via proxy");
    assert.equal(proxy.seen.length, 1);
    const sent = new URL(proxy.seen[0].url);
    assert.match(sent.hostname, LOCAL_LITERAL, "an IP literal, not the name the proxy could re-resolve");
    assert.equal(sent.port, "8099");
    assert.equal(sent.pathname + sent.search, "/x?y=1");
    assert.equal(proxy.seen[0].headers.host, "localhost:8099");
  } finally { proxy.close(); }
});

test("proxy, guarded: a name resolving to a blocked address never reaches the proxy", async () => {
  const proxy = await serve((_req, res) => { res.writeHead(200); res.end("INTERNAL"); });
  try {
    await assert.rejects(
      nodeFetch("http://localhost:8099/", { blockAddress: _isPrivateHost, proxyFor: () => proxy.base, timeoutMs: 2000 }),
      /refusing to connect/,
    );
    await assert.rejects(
      nodeFetch("http://localhost./", { blockAddress: (h: string) => h === "127.0.0.1" || h === "::1", proxyFor: () => proxy.base, timeoutMs: 2000 }),
      (e: Error) => /resolves to a private or loopback address/.test(e.message) && !/127\.0\.0\.1|::1/.test(e.message),
    );
    assert.equal(proxy.seen.length, 0);
  } finally { proxy.close(); }
});

test("proxy, guarded: every private address refused as a REDIRECT target; the proxy sees only the first hop", async () => {
  let target = "";
  const proxy = await serve((_req, res) => { res.writeHead(302, { Location: target }); res.end(); });
  try {
    for (const u of PRIVATE_URLS) {
      target = u;
      const before = proxy.seen.length;
      // The first hop is a public-looking literal the test lets through.
      const block = (h: string) => h !== "93.184.216.34" && _isPrivateHost(h);
      await assert.rejects(nodeFetch("http://93.184.216.34/start", { blockAddress: block, proxyFor: () => proxy.base, timeoutMs: 2000 }), /refusing to connect/, `redirect → ${u}`);
      assert.equal(proxy.seen.length, before + 1, `only the first hop reached the proxy (${u})`);
    }
  } finally { proxy.close(); }
});

test("proxy, guarded https: CONNECT names the checked address and port; a refusal rejects", async () => {
  const connects: string[] = [];
  const server = http.createServer();
  server.on("connect", (req: any, sock: any) => { connects.push(req.url); sock.end("HTTP/1.1 403 Forbidden\r\n\r\n"); });
  const base: string = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`)));
  try {
    await assert.rejects(
      nodeFetch("https://localhost/secure", { blockAddress: () => false, proxyFor: () => base, timeoutMs: 2000 }),
      /proxy refused the connection \(HTTP 403\)/,
    );
    assert.equal(connects.length, 1);
    const m = /^(.*):(\d+)$/.exec(connects[0]);
    assert.ok(m, connects[0]);
    assert.match(m[1], LOCAL_LITERAL);
    assert.equal(m[2], "443");
  } finally { server.close(); }
});

test("proxy: credentials in the proxy URL go to the proxy as Proxy-Authorization", async () => {
  const proxy = await serve((_req, res) => { res.writeHead(200); res.end("ok"); });
  try {
    const authed = proxy.base.replace("http://", "http://us%40er:p%3Ass@");
    await nodeFetch("http://localhost:8099/", { blockAddress: () => false, proxyFor: () => authed, timeoutMs: 2000 });
    assert.equal(proxy.seen[0].headers["proxy-authorization"], `Basic ${Buffer.from("us@er:p:ss").toString("base64")}`);
  } finally { proxy.close(); }
});

test("proxy: only http:// proxies; a malformed proxy setting rejects clearly", async () => {
  await assert.rejects(nodeFetch("http://a.org/", { proxyFor: () => "socks5://p:1080" }), /unsupported proxy protocol socks5:/);
  await assert.rejects(nodeFetch("http://a.org/", { proxyFor: () => "not a url" }), /proxy setting is not a valid URL/);
});

test("proxy: an unreachable proxy fails without naming its address", async () => {
  await assert.rejects(
    nodeFetch("https://a.org/", { blockAddress: () => false, proxyFor: () => "http://127.0.0.1:1", timeoutMs: 2000 }),
    (e: Error) => /could not reach the configured proxy \(ECONNREFUSED\)/.test(e.message) && !/127\.0\.0\.1/.test(e.message),
  );
  await assert.rejects(
    nodeFetch("http://a.org/", { blockAddress: () => false, proxyFor: () => "http://127.0.0.1:1", timeoutMs: 2000 }),
    (e: Error) => /could not reach the configured proxy/.test(e.message) && !/127\.0\.0\.1/.test(e.message),
  );
});

test("proxyFromEnv: a value without a scheme means http:// (as curl reads it)", () => {
  assert.equal(proxyFromEnv({ HTTPS_PROXY: "proxy.corp:3128" })(new URL("https://a.org/")), "http://proxy.corp:3128");
  assert.equal(proxyFromEnv({ http_proxy: "10.0.0.1:3128" })(new URL("http://a.org/")), "http://10.0.0.1:3128");
  assert.equal(proxyFromEnv({ HTTPS_PROXY: "https://p:443" })(new URL("https://a.org/")), "https://p:443", "kept as given; nodeFetch rejects it clearly");
});
