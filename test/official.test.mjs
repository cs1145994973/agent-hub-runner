// @意图#R912(2026-11-20): 官方套餐在运行器这边：登录（设备码事件、Codex 粘贴回调、取消）只写本机配置 600、不回令牌；到期前刷新且同一时刻只刷一次；
// 刷新被拒删凭据提示重登；转发去掉服务器鉴权换真令牌、改指纹头、域名白名单、回复分段 base64 去掉 content-encoding；叫停立刻断开不再回数据
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOfficial, rewriteFingerprint, OFFICIAL_ERR, REFRESH_BEFORE_MS } from "../official.mjs";
import { createSession, saveConfig } from "../runner.mjs";

const SYS = { platform: "darwin", arch: "arm64", release: "24.1.0", node: "v22.9.0" };
const NOW = 1_800_000_000_000;
const tick = () => new Promise((r) => setImmediate(r));
const until = async (fn, ms = 2000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error("等太久"); await new Promise((r) => setTimeout(r, 5)); } };
const collect = () => { const out = []; return { out, send: (m) => out.push(m) }; };
const fresh = (access = "real-a", extra = {}) => ({ type: "oauth", access, refresh: "real-r", expires: NOW + 3600_000, ...extra });

/** 假的 pi-ai 登录模块 */
function fakeOAuth(over = {}) {
  const calls = { refresh: 0, login: 0 };
  const mk = (toAuth) => ({
    login: async () => { calls.login += 1; return fresh(); },
    refresh: async (c) => { calls.refresh += 1; await new Promise((r) => setTimeout(r, 20)); return { ...c, access: `new-${calls.refresh}`, expires: NOW + 3600_000 }; },
    toAuth: toAuth,
  });
  const o = {
    kimiCodingOAuth: mk(async (c) => ({ headers: { Authorization: `Bearer ${c.access}` } })),
    xaiOAuth: mk(async (c) => ({ apiKey: c.access })),
    githubCopilotOAuth: mk(async (c) => ({ apiKey: c.access, baseUrl: "https://api.individual.githubcopilot.com" })),
    openaiCodexOAuth: mk(async (c) => ({ apiKey: c.access })),
  };
  for (const [k, v] of Object.entries(over)) Object.assign(o[k], v);
  return { o, calls };
}

/** 假的官方服务器：记下请求，回 3 段 */
function fakeFetch({ chunks = ["da", "ta:", " ok"], delay = 0, status = 200 } = {}) {
  const reqs = [];
  const fn = async (url, init) => {
    reqs.push({ url, init });
    const enc = new TextEncoder();
    const body = new ReadableStream({
      async pull(ctrl) {
        const c = chunks.shift();
        if (c === undefined) { ctrl.close(); return; }
        if (delay) await new Promise((r) => setTimeout(r, delay));
        ctrl.enqueue(enc.encode(c));
      },
    });
    init.signal?.addEventListener("abort", () => { fn.aborted = true; });
    return new Response(body, { status, headers: { "content-type": "text/event-stream", "content-encoding": "gzip", "content-length": "99", "x-request-id": "rq1" } });
  };
  fn.reqs = reqs;
  return fn;
}

const mkOfficial = (cfg, extra = {}) => {
  const saves = [];
  const { o, calls } = extra.fake ?? fakeOAuth();
  const fetchImpl = extra.fetchImpl ?? fakeFetch();
  const off = createOfficial(cfg, { save: () => saves.push(JSON.parse(JSON.stringify(cfg.official ?? {}))), oauth: o, fetchImpl, now: () => NOW, sys: SYS });
  return { off, saves, calls, fetchImpl };
};
const b64 = (s) => Buffer.from(s).toString("base64");
const fetchMsg = (over = {}) => ({ type: "model_fetch", id: "f1", provider: "kimi-coding", url: "https://api.kimi.com/coding/v1/messages", method: "POST",
  headers: [["Authorization", "Bearer hub-placeholder"], ["x-api-key", "hub-placeholder"], ["content-type", "application/json"], ["x-stainless-os", "Linux"], ["x-stainless-arch", "x64"], ["x-stainless-runtime-version", "v24.0.0"], ["user-agent", "pi (linux 6.8.0; x64)"], ["content-length", "12"], ["cookie", "a=b"]],
  body: b64('{"hello":1}'), ...over });

test("O1 转发：去掉服务器的鉴权 / cookie，换本机真令牌；指纹头改成这台电脑的；请求体原样；回复头去掉 content-encoding / 长度，数据分段 base64", async () => {
  const cfg = { official: { "kimi-coding": fresh("kimi-real") } };
  const { off, fetchImpl } = mkOfficial(cfg);
  const c = collect();
  await off.onMessage(fetchMsg(), c.send);
  const r = fetchImpl.reqs[0];
  assert.equal(r.url, "https://api.kimi.com/coding/v1/messages");
  assert.equal(r.init.headers.authorization, "Bearer kimi-real");
  assert.equal(r.init.headers["x-api-key"], undefined);
  assert.equal(r.init.headers.cookie, undefined);
  assert.equal(r.init.headers["content-length"], undefined);
  assert.equal(r.init.headers["x-stainless-os"], "MacOS");
  assert.equal(r.init.headers["x-stainless-arch"], "arm64");
  assert.equal(r.init.headers["x-stainless-runtime-version"], "v22.9.0");
  assert.equal(r.init.headers["user-agent"], "pi (darwin 24.1.0; arm64)");
  assert.equal(Buffer.from(r.init.body).toString(), '{"hello":1}');
  assert.equal(r.init.redirect, "manual");
  assert.deepEqual(c.out.map((m) => m.type), ["model_head", "model_chunk", "model_chunk", "model_chunk", "model_end"]);
  const head = c.out[0];
  assert.equal(head.status, 200);
  const hk = head.headers.map(([k]) => k);
  assert.ok(hk.includes("x-request-id") && hk.includes("content-type"));
  assert.ok(!hk.includes("content-encoding") && !hk.includes("content-length"));
  assert.equal(c.out.filter((m) => m.type === "model_chunk").map((m) => Buffer.from(m.data, "base64").toString()).join(""), "data: ok");
  assert.ok(!JSON.stringify(c.out).includes("kimi-real"), "令牌不能回给服务器");
});

test("O2 xAI / Codex 用 apiKey 换 Bearer；Codex 补 chatgpt-account-id；Copilot 按令牌里的地址发、只认 githubcopilot.com", async () => {
  const cfg = { official: { xai: fresh("x-real"), "openai-codex": fresh("jwt-real", { accountId: "acct-9" }), "github-copilot": fresh("cop-real") } };
  const { off, fetchImpl } = mkOfficial(cfg);
  await off.onMessage(fetchMsg({ id: "x", provider: "xai", url: "https://api.x.ai/v1/responses" }), () => {});
  await off.onMessage(fetchMsg({ id: "c", provider: "openai-codex", url: "https://chatgpt.com/backend-api/codex/responses", headers: [["chatgpt-account-id", "hub-placeholder"], ["authorization", "Bearer x"]] }), () => {});
  await off.onMessage(fetchMsg({ id: "g", provider: "github-copilot", url: "https://proxy.individual.githubcopilot.com/chat/completions?x=1" }), () => {});
  const [x, c, g] = fetchImpl.reqs;
  assert.equal(x.init.headers.authorization, "Bearer x-real");
  assert.equal(c.init.headers.authorization, "Bearer jwt-real");
  assert.equal(c.init.headers["chatgpt-account-id"], "acct-9");
  assert.equal(g.url, "https://api.individual.githubcopilot.com/chat/completions?x=1");
  assert.equal(g.init.headers.authorization, "Bearer cop-real");
});

test("O3 白名单：别的域名、http、带端口、带账号密码、别家的地址都拦下，根本不发", async () => {
  const cfg = { official: { "kimi-coding": fresh(), xai: fresh() } };
  const { off, fetchImpl } = mkOfficial(cfg);
  const bad = [
    ["kimi-coding", "https://evil.example.com/coding/v1/messages"],
    ["kimi-coding", "http://api.kimi.com/coding/v1/messages"],
    ["kimi-coding", "https://api.kimi.com:8443/coding"],
    ["kimi-coding", "https://u:p@api.kimi.com/coding"],
    ["kimi-coding", "https://api.x.ai/v1/responses"],
    ["kimi-coding", "https://api.kimi.com.evil.com/x"],
    ["xai", "not a url"],
  ];
  for (const [provider, url] of bad) {
    const c = collect();
    await off.onMessage(fetchMsg({ provider, url }), c.send);
    assert.equal(c.out.length, 1, url);
    assert.equal(c.out[0].type, "model_error");
    assert.equal(c.out[0].code, "blocked", url);
  }
  assert.equal(fetchImpl.reqs.length, 0);
  const c = collect();
  await off.onMessage(fetchMsg({ provider: "anthropic" }), c.send);
  assert.equal(c.out[0].code, "unknown");
});

test("O4 叫停：转发中途 abort，立刻断开对官方的请求，之后不再回数据段也不回 end", async () => {
  const cfg = { official: { "kimi-coding": fresh() } };
  const fetchImpl = fakeFetch({ chunks: ["a", "b", "c", "d", "e", "f"], delay: 30 });
  const { off } = mkOfficial(cfg, { fetchImpl });
  const c = collect();
  const p = off.onMessage(fetchMsg({ id: "s1" }), c.send);
  await until(() => c.out.some((m) => m.type === "model_chunk"));
  off.abort("s1");
  await p;
  const n = c.out.length;
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(c.out.length, n);
  assert.ok(fetchImpl.aborted, "对官方的请求要断开");
  assert.ok(!c.out.some((m) => m.type === "model_end" || m.type === "model_error"));
  assert.ok(c.out.filter((m) => m.type === "model_chunk").length < 6);
});

test("O5 快过期：并发两次请求只刷新一次，新令牌立刻写回（save）且两次都用新令牌", async () => {
  const cfg = { official: { "kimi-coding": fresh("old", { expires: NOW + REFRESH_BEFORE_MS - 1000 }) } };
  const { off, saves, calls, fetchImpl } = mkOfficial(cfg);
  await Promise.all([off.onMessage(fetchMsg({ id: "a" }), () => {}), off.onMessage(fetchMsg({ id: "b" }), () => {})]);
  assert.equal(calls.refresh, 1);
  assert.equal(fetchImpl.reqs.length, 2);
  assert.deepEqual(fetchImpl.reqs.map((r) => r.init.headers.authorization), ["Bearer new-1", "Bearer new-1"]);
  assert.equal(saves.length, 1);
  assert.equal(saves[0]["kimi-coding"].access, "new-1");
  assert.equal(cfg.official["kimi-coding"].access, "new-1");
});

test("O5b 刷新只调一次（计数精确）；没过期不刷新", async () => {
  const fake = fakeOAuth();
  const cfg = { official: { xai: fresh("old", { expires: NOW + 1000 }), "kimi-coding": fresh("ok") } };
  const { off } = mkOfficial(cfg, { fake });
  await Promise.all([1, 2, 3].map((i) => off.freshCred("xai")));
  assert.equal(fake.calls.refresh, 1);
  await off.freshCred("kimi-coding");
  assert.equal(fake.calls.refresh, 1);
});

test("O6 刷新被拒（invalid_grant / 401）：删掉本机凭据、回 login_expired 提示重新登录；没登录回 not_logged_in", async () => {
  const fake = fakeOAuth({ xaiOAuth: { refresh: async () => { throw new Error("xAI OAuth token refresh failed (HTTP 400): invalid_grant: revoked"); } } });
  const cfg = { official: { xai: fresh("old", { expires: NOW - 1 }) } };
  const { off, saves } = mkOfficial(cfg, { fake });
  const c = collect();
  await off.onMessage(fetchMsg({ provider: "xai", url: "https://api.x.ai/v1/responses" }), c.send);
  assert.equal(c.out[0].code, "login_expired");
  assert.equal(c.out[0].error, OFFICIAL_ERR.expired("Grok（xAI）"));
  assert.equal(cfg.official.xai, undefined);
  assert.equal(saves.length, 1);
  const c2 = collect();
  await off.onMessage(fetchMsg({ provider: "xai", url: "https://api.x.ai/v1/responses" }), c2.send);
  assert.equal(c2.out[0].code, "not_logged_in");
  // 网络错误不删凭据
  const fake2 = fakeOAuth({ kimiCodingOAuth: { refresh: async () => { throw new Error("fetch failed: ECONNRESET"); } } });
  const cfg2 = { official: { "kimi-coding": fresh("old", { expires: NOW - 1 }) } };
  const m2 = mkOfficial(cfg2, { fake: fake2 });
  const c3 = collect();
  await m2.off.onMessage(fetchMsg(), c3.send);
  assert.equal(c3.out[0].type, "model_error");
  assert.ok(cfg2.official["kimi-coding"]);
});

test("O7 登录：设备码事件只带链接和确认码，成功后令牌只写本机（save），回 done + Copilot 可用模型；status 不带令牌", async () => {
  const fake = fakeOAuth({ githubCopilotOAuth: { login: async (it) => {
    assert.equal(await it.prompt({ type: "text", message: "enterprise?" }), "");
    it.notify({ type: "device_code", userCode: "GH-1", verificationUri: "https://github.com/login/device", expiresInSeconds: 900, deviceCode: "SECRET-DC" });
    it.notify({ type: "device_code", userCode: "X", verificationUri: "javascript:alert(1)" });
    return fresh("cop", { availableModelIds: ["gpt-4.1", 5] });
  } } });
  const cfg = {};
  const { off, saves } = mkOfficial(cfg, { fake });
  const c = collect();
  off.onMessage({ type: "official_login", id: "q1", login_id: "L1", provider: "github-copilot" }, c.send);
  await until(() => c.out.some((m) => m.done));
  assert.deepEqual(c.out[0], { type: "result", id: "q1", ok: true });
  const evs = c.out.filter((m) => m.event).map((m) => m.event);
  assert.deepEqual(evs[0], { type: "device_code", userCode: "GH-1", url: "https://github.com/login/device", expiresInSeconds: 900 });
  assert.equal(evs[1].url, null, "非 http 链接不给网页");
  const done = c.out.find((m) => m.done);
  assert.deepEqual(done.meta, { availableModelIds: ["gpt-4.1"] });
  assert.ok(!JSON.stringify(c.out).includes("SECRET-DC") && !JSON.stringify(c.out).includes("real-r"));
  assert.equal(saves.at(-1)["github-copilot"].access, "cop");
  assert.deepEqual(off.status(), { "github-copilot": { logged_in: true, meta: { availableModelIds: ["gpt-4.1"] } } });
  // 退出：删本机令牌
  const c2 = collect();
  await off.onMessage({ type: "official_logout", id: "o1", provider: "github-copilot" }, c2.send);
  assert.equal(c2.out[0].ok, true);
  assert.deepEqual(off.status(), {});
});

test("O8 Codex 登录：选浏览器；要粘贴回调地址时网页收到 need_input，粘贴后完成；取消则不再回任何事件", async () => {
  let got;
  const fake = fakeOAuth({ openaiCodexOAuth: { login: async (it) => {
    assert.equal(await it.prompt({ type: "select", options: [{ id: "browser" }, { id: "device_code" }] }), "browser");
    it.notify({ type: "auth_url", url: "https://auth.openai.com/oauth/authorize?x=1" });
    got = await it.prompt({ type: "manual_code", message: "paste" });
    return fresh("jwt", { accountId: "acct" });
  } } });
  const cfg = {};
  const { off } = mkOfficial(cfg, { fake });
  const c = collect();
  off.onMessage({ type: "official_login", id: "q", login_id: "L2", provider: "openai-codex" }, c.send);
  await until(() => c.out.some((m) => m.event?.type === "need_input"));
  assert.equal(c.out.find((m) => m.event?.type === "auth_url").event.url, "https://auth.openai.com/oauth/authorize?x=1");
  const c2 = collect();
  off.onMessage({ type: "official_login_input", id: "i", login_id: "L2", input: "http://localhost:1455/auth/callback?code=c&state=s" }, c2.send);
  assert.equal(c2.out[0].ok, true);
  await until(() => c.out.some((m) => m.done));
  assert.equal(got, "http://localhost:1455/auth/callback?code=c&state=s");
  assert.equal(cfg.official["openai-codex"].accountId, "acct");
  // 取消
  const fake2 = fakeOAuth({ kimiCodingOAuth: { login: (it) => new Promise((_, rej) => it.signal.addEventListener("abort", () => rej(new Error("Login cancelled")))) } });
  const m2 = mkOfficial({}, { fake: fake2 });
  const c3 = collect();
  m2.off.onMessage({ type: "official_login", id: "q", login_id: "L3", provider: "kimi-coding" }, c3.send);
  await tick();
  m2.off.onMessage({ type: "official_login_cancel", id: "x", login_id: "L3" }, c3.send);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(c3.out.map((m) => m.type), ["result", "result"]);
  assert.equal(m2.off.status()["kimi-coding"], undefined);
});

test("O9 登录失败把原因回网页；不认识的套餐直接拒绝", async () => {
  const fake = fakeOAuth({ xaiOAuth: { login: async () => { throw new Error("Device flow failed: access_denied"); } } });
  const { off } = mkOfficial({}, { fake });
  const c = collect();
  off.onMessage({ type: "official_login", id: "q", login_id: "L", provider: "xai" }, c.send);
  await until(() => c.out.some((m) => m.error));
  assert.match(c.out.find((m) => m.error).error, /access_denied/);
  const c2 = collect();
  off.onMessage({ type: "official_login", id: "q2", login_id: "L9", provider: "anthropic" }, c2.send);
  assert.deepEqual(c2.out, [{ type: "result", id: "q2", ok: false, error: OFFICIAL_ERR.unknown }]);
});

test("O10 rewriteFingerprint：只改已有的指纹头，pi 之外的 UA 不动", () => {
  assert.deepEqual(rewriteFingerprint({ "user-agent": "OpenAI/JS 5.0", "x-stainless-os": "Linux" }, { ...SYS, platform: "win32", arch: "x64" }), { "user-agent": "OpenAI/JS 5.0", "x-stainless-os": "Windows" });
  assert.deepEqual(rewriteFingerprint({ a: "1" }, SYS), { a: "1" });
});

test("O11 createSession 接上：hello 用的 officialStatus、model_fetch / 登录消息路由、abort 叫停转发、令牌写配置文件 600", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "r912-"));
  try {
    const file = path.join(dir, "c.json");
    saveConfig({ server: "http://127.0.0.1:1", device_id: "d", token: "tok-x" }, file);
    const cfg = JSON.parse(readFileSync(file, "utf8"));
    const { o } = fakeOAuth();
    const fetchImpl = fakeFetch({ chunks: ["1", "2", "3", "4", "5"], delay: 30 });
    const s = createSession(cfg, { log: () => {}, file, oauth: o, modelFetch: fetchImpl });
    assert.deepEqual(s.officialStatus(), {});
    const c = collect();
    s.onMessage({ type: "official_login", id: "q", login_id: "L", provider: "kimi-coding" }, c.send);
    await until(() => c.out.some((m) => m.done));
    assert.deepEqual(s.officialStatus(), { "kimi-coding": { logged_in: true, meta: {} } });
    const saved = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(saved.official["kimi-coding"].refresh, "real-r");
    assert.equal(saved.token, "tok-x");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    // 转发 + 叫停走 session 的 abort
    cfg.official["kimi-coding"].expires = Date.now() + 3600_000;
    const c2 = collect();
    const p = s.onMessage(fetchMsg({ id: "z" }), c2.send);
    await until(() => c2.out.some((m) => m.type === "model_chunk"));
    s.onMessage({ type: "abort", id: "z" }, () => {});
    await p;
    assert.ok(fetchImpl.aborted);
    assert.ok(!c2.out.some((m) => m.type === "model_end"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
