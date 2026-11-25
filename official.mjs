// @意图#R912(2026-11-20): 官方套餐（登录型）只在这台电脑上用：令牌存本机配置（600，和 R751 搜索 key 一样不出这台电脑），服务器只放占位凭据；
// 服务器把模型请求经 WebSocket 交给这里，换上真令牌、改掉服务器指纹头再发给官方固定域名，回复分段回传；登录 / 刷新用 pi-ai 打包的 oauth.bundle.mjs。
// 第一期四家：kimi-coding、xai（Grok）、github-copilot、openai-codex（king 定，不做 Anthropic / Gemini）。
import os from "node:os";

/** 四家官方套餐：hosts = 只许发往的固定域名（https）；hostSuffix = Copilot 按令牌里的 proxy-ep 换地址，只认这个后缀 */
export const OFFICIAL = {
  "kimi-coding": { name: "Kimi Code", oauth: "kimiCodingOAuth", hosts: ["api.kimi.com"] },
  xai: { name: "Grok（xAI）", oauth: "xaiOAuth", hosts: ["api.x.ai"] },
  "github-copilot": { name: "GitHub Copilot", oauth: "githubCopilotOAuth", hosts: [], hostSuffix: ".githubcopilot.com" },
  "openai-codex": { name: "ChatGPT（Codex）", oauth: "openaiCodexOAuth", hosts: ["chatgpt.com"] },
};
export const OFFICIAL_IDS = Object.keys(OFFICIAL);
/** 令牌离过期不到 5 分钟就先刷新（和 pi 一样） */
export const REFRESH_BEFORE_MS = 5 * 60_000;
export const REFRESH_TIMEOUT_MS = 30_000;
export const OFFICIAL_ERR = {
  unknown: "不认识的官方套餐",
  notLoggedIn: (name) => `这台电脑还没登录「${name}」，请在网页「设置 → 我的模型」里这台电脑下面点「登录」`,
  expired: (name) => `「${name}」在这台电脑上的登录已失效，请在网页「设置 → 我的模型」里重新登录`,
  blocked: (host) => `官方套餐只许发往官方地址，${host} 不在名单里，已拦下`,
};
/** 服务器给的这些头一律不带出去：鉴权换成本机真令牌，连接相关的交给本机 fetch */
const DROP_HEADERS = new Set(["authorization", "x-api-key", "proxy-authorization", "cookie", "host", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade", "te", "trailer"]);
/** 回给服务器时去掉：本机 fetch 已经解压，长度也变了 */
const DROP_RESPONSE_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "set-cookie"]);
const STAINLESS_OS = { darwin: "MacOS", win32: "Windows", linux: "Linux", freebsd: "FreeBSD", openbsd: "OpenBSD", android: "Android" };
const UNAUTHORIZED = /unauthori[sz]ed|invalid_grant|\b40[13]\b|forbidden/i;

class OfficialError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** 服务器 SDK 带的系统指纹（x-stainless-*、pi 的 User-Agent）改成这台电脑的，不让官方看出请求是从服务器来的 */
export function rewriteFingerprint(headers, sys = { platform: process.platform, arch: process.arch, release: os.release(), node: process.version }) {
  const out = { ...headers };
  if ("x-stainless-os" in out) out["x-stainless-os"] = STAINLESS_OS[sys.platform] ?? `Other:${sys.platform}`;
  if ("x-stainless-arch" in out) out["x-stainless-arch"] = sys.arch === "ia32" ? "x32" : sys.arch === "x64" || sys.arch === "arm64" || sys.arch === "arm" ? sys.arch : `other:${sys.arch}`;
  if ("x-stainless-runtime" in out) out["x-stainless-runtime"] = "node";
  if ("x-stainless-runtime-version" in out) out["x-stainless-runtime-version"] = sys.node;
  if (typeof out["user-agent"] === "string" && /^pi \([^)]*\)$/.test(out["user-agent"])) out["user-agent"] = `pi (${sys.platform} ${sys.release}; ${sys.arch})`;
  return out;
}

const httpUrl = (v) => { try { const u = new URL(String(v)); return u.protocol === "https:" || u.protocol === "http:" ? u.href : null; } catch { return null; } };
/** 只把网页要用的几样字段回给服务器（链接只认 http/https） */
export function cleanEvent(e) {
  if (!e || typeof e !== "object") return null;
  if (e.type === "device_code") return { type: "device_code", userCode: String(e.userCode ?? ""), url: httpUrl(e.verificationUri), expiresInSeconds: Number(e.expiresInSeconds) || null };
  if (e.type === "auth_url") return { type: "auth_url", url: httpUrl(e.url), instructions: typeof e.instructions === "string" ? e.instructions : null };
  if (e.type === "progress" || e.type === "info") return { type: "progress", message: String(e.message ?? e.text ?? "") };
  return null;
}

/** 回给服务器的登录状态：不带任何令牌，只有 Copilot 的可用模型列表 */
export function metaOf(provider, cred) {
  if (provider === "github-copilot" && Array.isArray(cred?.availableModelIds)) return { availableModelIds: cred.availableModelIds.filter((x) => typeof x === "string").slice(0, 200) };
  return {};
}

/**
 * 官方套餐管理：cfg.official = { [provider]: 凭据 }，save() 立刻写回配置文件（600）。
 * deps：oauth（测试注入；默认按需 import 打包的 oauth.bundle.mjs）、fetchImpl、now、sys（指纹）。
 */
export function createOfficial(cfg, { save, log = () => {}, oauth, fetchImpl = (...a) => globalThis.fetch(...a), now = Date.now, sys } = {}) {
  const refreshing = new Map(); // provider → 正在刷新的 Promise（同一时刻只刷一次）
  const logins = new Map(); // login_id → { provider, ac, input }
  const fetches = new Map(); // 请求 id → AbortController
  let bundle = oauth ? Promise.resolve(oauth) : null;
  const getOAuth = async (provider) => {
    bundle ??= import("./oauth.bundle.mjs");
    const m = await bundle;
    const o = m[OFFICIAL[provider].oauth];
    if (!o) throw new OfficialError("unknown", OFFICIAL_ERR.unknown);
    return o;
  };
  const creds = () => (cfg.official && typeof cfg.official === "object" ? cfg.official : (cfg.official = {}));
  const write = (provider, cred) => { const all = creds(); if (cred) all[provider] = cred; else delete all[provider]; save?.(); };

  function status() {
    const out = {};
    for (const id of OFFICIAL_IDS) {
      const c = creds()[id];
      if (c && typeof c.refresh === "string") out[id] = { logged_in: true, meta: metaOf(id, c) };
    }
    return out;
  }

  // @意图#R912(2026-11-20): 令牌到期前刷新；同一家同一时刻只刷一次（Kimi 令牌 15 分钟、刷新会换 refresh 令牌），刷完立刻写回；刷新被拒就删掉本机凭据、提示重新登录
  async function freshCred(provider) {
    const cur = creds()[provider];
    if (!cur) throw new OfficialError("not_logged_in", OFFICIAL_ERR.notLoggedIn(OFFICIAL[provider].name));
    if (typeof cur.expires === "number" && cur.expires - now() > REFRESH_BEFORE_MS) return cur;
    let p = refreshing.get(provider);
    if (!p) {
      p = (async () => {
        try {
          const o = await getOAuth(provider);
          const next = await o.refresh(cur, AbortSignal.timeout(REFRESH_TIMEOUT_MS));
          const merged = { ...cur, ...next, type: "oauth" };
          write(provider, merged);
          log(`「${OFFICIAL[provider].name}」令牌已刷新`);
          return merged;
        } catch (e) {
          if (UNAUTHORIZED.test(e?.message ?? "")) {
            write(provider, undefined);
            throw new OfficialError("login_expired", OFFICIAL_ERR.expired(OFFICIAL[provider].name));
          }
          throw e;
        } finally { refreshing.delete(provider); }
      })();
      refreshing.set(provider, p);
    }
    return p;
  }

  /** 把服务器转来的请求改成发往官方的真请求：地址白名单、去掉服务器给的鉴权、换真令牌、改指纹 */
  async function prepare(msg) {
    const provider = msg.provider;
    const spec = OFFICIAL[provider];
    if (!spec) throw new OfficialError("unknown", OFFICIAL_ERR.unknown);
    const cred = await freshCred(provider);
    const o = await getOAuth(provider);
    const auth = (await o.toAuth(cred)) ?? {};
    let url;
    try { url = new URL(String(msg.url)); } catch { throw new OfficialError("blocked", OFFICIAL_ERR.blocked(String(msg.url))); }
    if (provider === "github-copilot" && auth.baseUrl) { const b = new URL(auth.baseUrl); url = new URL(`${url.pathname}${url.search}`, b.origin); }
    const host = url.hostname.toLowerCase();
    const ok = url.protocol === "https:" && !url.username && !url.password && (url.port === "" || url.port === "443")
      && (spec.hosts.includes(host) || (spec.hostSuffix && host.endsWith(spec.hostSuffix))
        || (provider === "github-copilot" && auth.baseUrl && new URL(auth.baseUrl).hostname === host));
    if (!ok) throw new OfficialError("blocked", OFFICIAL_ERR.blocked(url.host || String(msg.url)));
    let headers = {};
    for (const pair of Array.isArray(msg.headers) ? msg.headers : []) {
      if (!Array.isArray(pair) || typeof pair[0] !== "string" || typeof pair[1] !== "string") continue;
      const k = pair[0].toLowerCase();
      if (!DROP_HEADERS.has(k)) headers[k] = pair[1];
    }
    headers = rewriteFingerprint(headers, sys);
    for (const [k, v] of Object.entries(auth.headers ?? {})) headers[k.toLowerCase()] = String(v);
    if (auth.apiKey) headers.authorization = `Bearer ${auth.apiKey}`;
    if (provider === "openai-codex" && typeof cred.accountId === "string") headers["chatgpt-account-id"] = cred.accountId;
    const method = typeof msg.method === "string" ? msg.method.toUpperCase() : "GET";
    const body = typeof msg.body === "string" && method !== "GET" && method !== "HEAD" ? Buffer.from(msg.body, "base64") : undefined;
    return { url: url.href, init: { method, headers, body, redirect: "manual" } };
  }

  // @意图#R912(2026-11-20): 转发一次模型请求：回复头 + 分段 base64 回传；服务器叫停（abort）立刻断开对官方的请求、不再回任何数据段
  async function relay(send, msg) {
    const { id } = msg;
    const ac = new AbortController();
    fetches.set(id, ac);
    try {
      const { url, init } = await prepare(msg);
      if (ac.signal.aborted) return;
      const res = await fetchImpl(url, { ...init, signal: ac.signal });
      if (ac.signal.aborted) { void res.body?.cancel().catch(() => {}); return; }
      const headers = [];
      res.headers.forEach((v, k) => { if (!DROP_RESPONSE_HEADERS.has(k.toLowerCase())) headers.push([k, v]); });
      send({ type: "model_head", id, status: res.status, status_text: res.statusText, headers });
      if (res.body) {
        for await (const chunk of res.body) {
          if (ac.signal.aborted) break;
          send({ type: "model_chunk", id, data: Buffer.from(chunk).toString("base64") });
        }
      }
      if (!ac.signal.aborted) send({ type: "model_end", id });
    } catch (e) {
      if (!ac.signal.aborted) send({ type: "model_error", id, code: e?.code ?? "network", error: e?.message ?? String(e) });
    } finally { fetches.delete(id); }
  }

  // @意图#R912(2026-11-20): 网页点「登录」：在这台电脑上走 pi 的登录流程（Kimi / Grok / Copilot 设备码，Codex 本机 1455 回调或粘贴回调地址），
  // 链接和确认码经服务器显示在网页上；成功后令牌只写本机配置
  function login(send, msg) {
    const { login_id: loginId, provider } = msg;
    const spec = OFFICIAL[provider];
    if (!spec || typeof loginId !== "string" || !loginId) { send({ type: "result", id: msg.id, ok: false, error: OFFICIAL_ERR.unknown }); return; }
    for (const [lid, l] of logins) if (l.provider === provider) { l.ac.abort(); logins.delete(lid); } // 同一家只留最新一次
    const ac = new AbortController();
    const entry = { provider, ac, input: null };
    logins.set(loginId, entry);
    const event = (e) => { if (!ac.signal.aborted && e) send({ type: "official_login_event", login_id: loginId, provider, event: e }); };
    send({ type: "result", id: msg.id, ok: true });
    log(`开始登录「${spec.name}」`);
    void (async () => {
      try {
        const o = await getOAuth(provider);
        const interaction = {
          signal: ac.signal,
          notify: (e) => event(cleanEvent(e)),
          prompt: (p) => {
            if (p?.type === "select") return Promise.resolve(provider === "openai-codex" ? "browser" : String(p.options?.[0]?.id ?? ""));
            if (p?.type === "manual_code") {
              event({ type: "need_input", message: "如果浏览器不在这台电脑上，登录完把浏览器地址栏里的回调地址粘贴过来" });
              return new Promise((resolve, reject) => {
                entry.input = resolve;
                const stop = () => reject(new Error("Login cancelled"));
                p.signal?.addEventListener("abort", stop, { once: true });
                ac.signal.addEventListener("abort", stop, { once: true });
              });
            }
            return Promise.resolve(""); // Copilot 问企业域名：留空 = github.com
          },
        };
        const cred = await o.login(interaction);
        if (ac.signal.aborted) return;
        write(provider, { ...cred, type: "oauth" });
        log(`「${spec.name}」登录成功，令牌只存在这台电脑上`);
        send({ type: "official_login_event", login_id: loginId, provider, done: true, meta: metaOf(provider, cred) });
      } catch (e) {
        if (!ac.signal.aborted) send({ type: "official_login_event", login_id: loginId, provider, error: e?.message ?? String(e) });
      } finally { if (logins.get(loginId) === entry) logins.delete(loginId); }
    })();
  }

  function loginInput(send, msg) {
    const l = logins.get(msg.login_id);
    if (!l?.input) { send({ type: "result", id: msg.id, ok: false, error: "这次登录现在不需要粘贴" }); return; }
    l.input(String(msg.input ?? ""));
    l.input = null;
    send({ type: "result", id: msg.id, ok: true });
  }

  function loginCancel(send, msg) {
    const l = logins.get(msg.login_id);
    if (l) { l.ac.abort(); logins.delete(msg.login_id); }
    send({ type: "result", id: msg.id, ok: true });
  }

  function logout(send, msg) {
    if (!OFFICIAL[msg.provider]) { send({ type: "result", id: msg.id, ok: false, error: OFFICIAL_ERR.unknown }); return; }
    write(msg.provider, undefined);
    log(`已退出「${OFFICIAL[msg.provider].name}」，本机令牌已删`);
    send({ type: "result", id: msg.id, ok: true });
  }

  return {
    status, freshCred, prepare, relay, login, loginInput, loginCancel, logout,
    /** 服务器叫停：断开对官方的请求 / 取消正在进行的登录 */
    abort(id) { fetches.get(id)?.abort(); },
    killAll() { for (const ac of fetches.values()) ac.abort(); fetches.clear(); for (const l of logins.values()) l.ac.abort(); logins.clear(); },
    handles(type) { return type === "model_fetch" || type === "official_login" || type === "official_login_input" || type === "official_login_cancel" || type === "official_logout"; },
    onMessage(msg, send) {
      if (msg.type === "model_fetch") return relay(send, msg);
      if (msg.type === "official_login") return login(send, msg);
      if (msg.type === "official_login_input") return loginInput(send, msg);
      if (msg.type === "official_login_cancel") return loginCancel(send, msg);
      if (msg.type === "official_logout") return logout(send, msg);
      return undefined;
    },
  };
}
