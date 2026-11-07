// R751：runner/search.mjs 单测。fetch 全部注入假的，不打真实网络。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseDuckDuckGo, decodeHtml, normalizeCount, cleanSearchConfig, searchConfigStatus, searchWeb } from "../search.mjs";
import { createSession } from "../runner.mjs";

const DDG_SAMPLE = `
<html><body>
<div class="result results_links web-result">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fx%3D1&amp;rut=abc">示例 &amp; 标题</a>
  <a class="result__snippet">这是 <b>摘要</b> 一</a>
</div>
<div class="result result--ad">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fad.example.com%2F">广告不要</a>
</div>
<div class="result results_links web-result">
  <a href="https://example.org/b" class="result__a">第二条</a>
  <div class="result__snippet">摘要 &quot;二&quot;</div>
</div>
</body></html>`;

const okText = (text) => async () => ({ ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) });
const okJson = (data) => async () => ({ ok: true, status: 200, text: async () => JSON.stringify(data), json: async () => data });

test("S1 DDG 解析：标题/链接/摘要、广告跳过、uddg 和实体解码", () => {
  const r = parseDuckDuckGo(DDG_SAMPLE, 5);
  assert.equal(r.length, 2);
  assert.equal(r[0].title, "示例 & 标题");
  assert.equal(r[0].url, "https://example.com/a?x=1");
  assert.equal(r[0].snippet, "这是 摘要 一");
  assert.equal(r[1].url, "https://example.org/b");
  assert.equal(r[1].snippet, '摘要 "二"');
});

test("S2 DDG 解析不到结果要说人话", () => {
  assert.throws(() => parseDuckDuckGo("<html><body>验证码</body></html>"), /没解析到结果/);
});

test("S3 count 归一化", () => {
  assert.equal(normalizeCount(undefined), 5);
  assert.equal(normalizeCount(0), 1);
  assert.equal(normalizeCount(99), 10);
  assert.equal(normalizeCount(3.9), 3);
});

test("S4 decodeHtml 数字实体和空白", () => {
  assert.equal(decodeHtml("a&#39;b&#x2F;c&nbsp; d\n e"), "a'b/c d e"); // 解码后多余空白折叠
});

test("S5 Tavily：Bearer 头、请求体、结果映射", async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return okJson({ results: [{ title: "t", url: "https://x", content: "c" }] })(); };
  const r = await searchWeb("你好", { search: { provider: "tavily", apiKey: "k1" }, fetchImpl });
  assert.equal(seen.url, "https://api.tavily.com/search");
  assert.equal(seen.init.headers.Authorization, "Bearer k1");
  assert.deepEqual(JSON.parse(seen.init.body), { query: "你好", max_results: 5 });
  assert.deepEqual(r.results, [{ title: "t", url: "https://x", snippet: "c" }]);
});

test("S6 Brave：token 头和 web.results 映射", async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url: String(url), init }; return okJson({ web: { results: [{ title: "b", url: "https://y", description: "d" }] } })(); };
  const r = await searchWeb("q", { search: { provider: "brave", apiKey: "k2" }, fetchImpl });
  assert.ok(seen.url.startsWith("https://api.search.brave.com/res/v1/web/search?"));
  assert.equal(seen.init.headers["X-Subscription-Token"], "k2");
  assert.equal(r.results[0].snippet, "d");
});

test("S7 SearXNG：地址拼接和 results 映射", async () => {
  let seen;
  const fetchImpl = async (url) => { seen = String(url); return okJson({ results: [{ title: "s", url: "https://z", content: "c" }] })(); };
  await searchWeb("q", { search: { provider: "searxng", searxngUrl: "http://127.0.0.1:8080/" }, fetchImpl });
  assert.ok(seen.startsWith("http://127.0.0.1:8080/search?"));
  assert.ok(seen.includes("format=json"));
});

test("S8 默认 duckduckgo；同查询 5 分钟内走缓存", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return okText(DDG_SAMPLE)(); };
  const a = await searchWeb("缓存测试", { fetchImpl });
  const b = await searchWeb("缓存测试", { fetchImpl });
  assert.equal(a.provider, "duckduckgo");
  assert.equal(calls, 1);
  assert.equal(b.cached, true);
});

test("S9 选了要 key 的 provider 但没 key，报错指路了", async () => {
  await assert.rejects(searchWeb("q", { search: { provider: "tavily" }, fetchImpl: okJson({}) }), /没配 key/);
  await assert.rejects(searchWeb("q", { search: { provider: "searxng" }, fetchImpl: okJson({}) }), /实例地址/);
});

test("S10 HTTP 错误：限流说人话", async () => {
  const fetchImpl = async () => ({ ok: false, status: 429, text: async () => "slow down" });
  await assert.rejects(searchWeb("q", { fetchImpl }), /HTTP 429.*限流/);
});

test("S11 cleanSearchConfig 校验", () => {
  assert.deepEqual(cleanSearchConfig({}), { provider: "duckduckgo" });
  assert.deepEqual(cleanSearchConfig({ provider: "tavily", apiKey: " k " }), { provider: "tavily", apiKey: "k" });
  assert.throws(() => cleanSearchConfig({ provider: "brave" }), /要填 API key/);
  assert.throws(() => cleanSearchConfig({ provider: "searxng", searxngUrl: "not a url" }));
  assert.deepEqual(searchConfigStatus({ provider: "tavily", apiKey: "x" }), { provider: "tavily", hasKey: true });
  assert.deepEqual(searchConfigStatus(undefined), { provider: "duckduckgo", hasKey: false });
});

// S12～S14：createSession 的 search / search_config 消息（R751）
test("S12 search 消息：用本机配置搜，结果回传", async () => {
  const cfg = { search: { provider: "tavily", apiKey: "本机key" } };
  const s = createSession(cfg, { log: () => {}, search: async (q, opts) => ({ provider: "tavily", results: [{ title: q, url: "https://x", snippet: String(opts.search.apiKey) }] }) });
  const sent = [];
  await s.onMessage({ type: "search", id: "a", bot_id: "b1", args: { query: "你好", count: 3 } }, (m) => sent.push(m));
  assert.equal(sent[0].ok, true);
  assert.equal(sent[0].provider, "tavily");
  assert.equal(sent[0].results[0].title, "你好");
  assert.equal(sent[0].results[0].snippet, "本机key"); // key 从本机配置来，不是服务器下发的
});

test("S13 search_config：写本机配置文件，只回状态不回 key", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hub-search-"));
  const file = path.join(dir, "config.json");
  const cfg = { server: "https://x", token: "t" };
  const s = createSession(cfg, { log: () => {}, file, search: async () => ({ provider: "duckduckgo", results: [] }) });
  const sent = [];
  await s.onMessage({ type: "search_config", id: "c", config: { provider: "brave", apiKey: " k9 " } }, (m) => sent.push(m));
  assert.deepEqual(sent[0], { type: "result", id: "c", ok: true, provider: "brave", hasKey: true });
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(saved.search.apiKey, "k9");
  assert.equal(saved.server, "https://x"); // 原有配置不动
  assert.equal(JSON.stringify(sent[0]).includes("k9"), false);
});

test("S14 搜索失败回中文错误；空 query 报错", async () => {
  const s = createSession({}, { log: () => {}, search: async () => { throw new Error("被限流了"); } });
  const sent = [];
  await s.onMessage({ type: "search", id: "e", bot_id: "b", args: { query: "x" } }, (m) => sent.push(m));
  assert.deepEqual(sent[0], { type: "result", id: "e", ok: false, error: "被限流了" });
});
