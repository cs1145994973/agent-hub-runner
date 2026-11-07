// @意图#R751(2026-11-07): king 确认 R751：运行器内置联网搜索，网页开关可选。
// 默认 DuckDuckGo 抓公开结果页（免注册免 key），可选 Tavily / Brave key、SearXNG 实例地址。
// key 只存本机 config.json（600），由网页下发（runner.mjs 的 search_config），服务器不存。
// 零依赖：DDG 的 HTML 解析自己写——开机自启安装只拷文件不装依赖（autostart.mjs 的 COPY_FILES），引第三方库会让自启那份跑不起来。
// 参考 pi-web-access 的 duckduckgo.ts 的做法（抓 html.duckduckgo.com/html/ 再解析）；DDG 是非官方接口，改版/限流会失败，报错要说人话。

export const SEARCH_PROVIDERS = ["duckduckgo", "tavily", "brave", "searxng"];
export const SEARCH_CACHE_MS = 5 * 60_000; // 同一个查询 5 分钟内不重查，防模型刷搜索
export const SEARCH_TIMEOUT_MS = 20_000;
const DDG_URL = "https://html.duckduckgo.com/html/";
const UA = "Mozilla/5.0 (compatible; agent-hub-runner/1.0; +https://github.com/cs1145994973/agent-hub-runner)";
const CACHE_MAX = 50;
const cache = new Map(); // key → { at, results }

export function normalizeCount(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return 5;
  return Math.max(1, Math.min(Math.floor(n), 10));
}

/** 去标签 + 解码常见 HTML 实体（DDG 的标题/摘要里有 <b> 和实体） */
export function decodeHtml(s) {
  return String(s ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, ent) => {
      const lower = ent.toLowerCase();
      if (lower.startsWith("#x")) return String.fromCodePoint(parseInt(lower.slice(2), 16));
      if (lower.startsWith("#")) return String.fromCodePoint(parseInt(lower.slice(1), 10));
      const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
      return named[lower] ?? m;
    })
    .replace(/\s+/g, " ")
    .trim();
}

function resultUrl(href) {
  try {
    const link = new URL(href, DDG_URL);
    const dest = link.searchParams.get("uddg") ?? link.href;
    const url = new URL(dest);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** 解析 DDG 结果页：按 class 含独立单词 result 的 div 分块，跳过广告块，提 result__a / result__snippet */
export function parseDuckDuckGo(html, count = 5) {
  const starts = [...String(html).matchAll(/<div[^>]*class="[^"]*\bresult\b[^"]*"[^>]*>/g)];
  const results = [];
  let parseable = 0;
  for (let i = 0; i < starts.length && results.length < count; i++) {
    const begin = starts[i].index;
    const end = i + 1 < starts.length ? starts[i + 1].index : html.length;
    const block = html.slice(begin, end);
    if (/result--ad/.test(starts[i][0])) continue;
    const a = block.match(/<a\b[^>]*result__a[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const href = a[0].match(/href="([^"]+)"/)?.[1] ?? "";
    const title = decodeHtml(a[1]);
    const url = href ? resultUrl(href) : null;
    if (!title || !url) continue;
    parseable++;
    const snip = block.match(/<(?:a|div)\b[^>]*result__snippet[^>]*>([\s\S]*?)<\/(?:a|div)>/);
    results.push({ title, url, snippet: snip ? decodeHtml(snip[1]) : "" });
  }
  if (parseable === 0) throw new Error("DuckDuckGo 这次没解析到结果：可能被限流或页面结构变了。可以换个说法再试、稍后再试，或在「我的电脑」里改配 Tavily / Brave key。");
  return results;
}

async function request(fetchImpl, url, init, signal) {
  const res = await fetchImpl(url, {
    ...init,
    signal: signal ? AbortSignal.any([AbortSignal.timeout(SEARCH_TIMEOUT_MS), signal]) : AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`搜索请求失败（HTTP ${res.status}）${res.status === 403 || res.status === 429 ? "：可能被限流，稍后再试" : ""}${body ? `：${body}` : ""}`);
  }
  return res;
}

async function searchDuckDuckGo(query, { count, fetchImpl, signal }) {
  const url = new URL(DDG_URL);
  url.searchParams.set("q", query);
  const res = await request(fetchImpl, url, { headers: { Accept: "text/html", "User-Agent": UA } }, signal);
  return parseDuckDuckGo(await res.text(), count);
}

async function searchTavily(query, { count, apiKey, fetchImpl, signal }) {
  const res = await request(fetchImpl, "https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query, max_results: count }),
  }, signal);
  const data = await res.json();
  return (data.results ?? []).slice(0, count).map((r) => ({ title: String(r.title ?? ""), url: String(r.url ?? ""), snippet: String(r.content ?? "") }));
}

async function searchBrave(query, { count, apiKey, fetchImpl, signal }) {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(count));
  const res = await request(fetchImpl, url, { headers: { Accept: "application/json", "X-Subscription-Token": apiKey } }, signal);
  const data = await res.json();
  return (data.web?.results ?? []).slice(0, count).map((r) => ({ title: String(r.title ?? ""), url: String(r.url ?? ""), snippet: String(r.description ?? "") }));
}

async function searchSearxng(query, { count, searxngUrl, fetchImpl, signal }) {
  const base = String(searxngUrl).replace(/\/+$/, "");
  const url = new URL(`${base}/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  const res = await request(fetchImpl, url, { headers: { Accept: "application/json", "User-Agent": UA } }, signal);
  const data = await res.json();
  return (data.results ?? []).slice(0, count).map((r) => ({ title: String(r.title ?? ""), url: String(r.url ?? ""), snippet: String(r.content ?? "") }));
}

/** 网页下发的配置写本地前的校验（runner.mjs 的 search_config 也用） */
export function cleanSearchConfig(raw) {
  const provider = SEARCH_PROVIDERS.includes(raw?.provider) ? raw.provider : "duckduckgo";
  const out = { provider };
  if (provider === "tavily" || provider === "brave") {
    const key = typeof raw?.apiKey === "string" ? raw.apiKey.trim() : "";
    if (!key) throw new Error(`${provider} 要填 API key`);
    if (key.length > 200) throw new Error("API key 太长了，检查一下是不是复制错了");
    out.apiKey = key;
  }
  if (provider === "searxng") {
    const url = String(raw?.searxngUrl ?? "").trim();
    const u = new URL(url); // 不合法直接抛
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("SearXNG 地址要以 http(s):// 开头");
    out.searxngUrl = url;
  }
  return out;
}

export function searchConfigStatus(search) {
  const provider = SEARCH_PROVIDERS.includes(search?.provider) ? search.provider : "duckduckgo";
  return { provider, hasKey: typeof search?.apiKey === "string" && search.apiKey.length > 0 };
}

/**
 * 搜一次。opts: { count, search（config.json 的 search 节）, fetchImpl（测试注入）, signal }
 * 返回 { provider, results: [{ title, url, snippet }] }；失败抛中文错误。
 */
export async function searchWeb(query, opts = {}) {
  const q = String(query ?? "").trim();
  if (!q) throw new Error("搜索词不能为空");
  const search = opts.search ?? {};
  const provider = SEARCH_PROVIDERS.includes(search.provider) ? search.provider : "duckduckgo";
  const count = normalizeCount(opts.count);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const cacheKey = `${provider}|${provider === "searxng" ? search.searxngUrl ?? "" : ""}|${count}|${q}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < SEARCH_CACHE_MS) return { provider, results: hit.results, cached: true };

  const args = { count, apiKey: search.apiKey, searxngUrl: search.searxngUrl, fetchImpl, signal: opts.signal };
  let results;
  if (provider === "tavily") {
    if (!args.apiKey) throw new Error("选了 Tavily 但没配 key：在「我的电脑」里填上，或切回 DuckDuckGo。");
    results = await searchTavily(q, args);
  } else if (provider === "brave") {
    if (!args.apiKey) throw new Error("选了 Brave 但没配 key：在「我的电脑」里填上，或切回 DuckDuckGo。");
    results = await searchBrave(q, args);
  } else if (provider === "searxng") {
    if (!args.searxngUrl) throw new Error("选了 SearXNG 但没填实例地址：在「我的电脑」里填上，或切回 DuckDuckGo。");
    results = await searchSearxng(q, args);
  } else {
    results = await searchDuckDuckGo(q, args);
  }
  cache.set(cacheKey, { at: Date.now(), results });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return { provider, results };
}
