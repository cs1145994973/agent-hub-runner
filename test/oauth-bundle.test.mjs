// @意图#R912(2026-11-20): 打包出来的 oauth.bundle.mjs 发布前的验证：用本机假 OAuth 服务器把四家（Kimi、Grok/xAI、GitHub Copilot、Codex）
// 的登录、换令牌、刷新、出错各跑一遍（不连真官方、不花钱）；release/oauth-bundle.mjs 打包后跑它，不过不准发布。OAUTH_BUNDLE_FILE 可指定要验的文件。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const FILE = process.env.OAUTH_BUNDLE_FILE || path.join(here, "..", "oauth.bundle.mjs");
const FAKE_HOSTS = new Set(["auth.kimi.com", "auth.x.ai", "github.com", "api.github.com", "api.individual.githubcopilot.com", "auth.openai.com"]);
let srv; let base; let realFetch; let B;
/** 每个用例自己定义假服务器怎么回：key = "host path" */
let routes = {};
const seen = [];

before(async () => {
  assert.ok(existsSync(FILE), `没有 ${FILE}，先 node release/oauth-bundle.mjs 打包`);
  srv = createServer((req, res) => {
    const [, host, ...rest] = req.url.split("/");
    const p = `/${rest.join("/")}`.split("?")[0];
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      seen.push({ host, path: p, method: req.method, body, auth: req.headers.authorization });
      const h = routes[`${host} ${p}`];
      const r = h ? h(new URLSearchParams(body), req) : { status: 404, json: { error: "not_found" } };
      res.writeHead(r.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(r.json ?? {}));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${srv.address().port}`;
  realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (FAKE_HOSTS.has(u.hostname)) return realFetch(`${base}/${u.hostname}${u.pathname}${u.search}`, init);
    if (u.hostname === "127.0.0.1" || u.hostname === "localhost") return realFetch(input, init);
    throw new Error(`验证测试不许连外网：${u.hostname}`);
  };
  B = await import(pathToFileURL(FILE).href);
});
after(() => { globalThis.fetch = realFetch; srv?.close(); });

/** 假的交互：记下 notify 的事件，prompt 按类型回 */
function interaction(answers = {}) {
  const events = [];
  const ac = new AbortController();
  return {
    events, ac,
    it: { signal: ac.signal, notify: (e) => events.push(e), prompt: async (p) => (typeof answers[p.type] === "function" ? answers[p.type](p, events) : answers[p.type] ?? "") },
  };
}
const jwt = (payload) => `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64")}.sig`;

test("产物头写了来源版本、输入文件合并 sha256 和 MIT 声明；只导出四家", async () => {
  const { readFileSync } = await import("node:fs");
  const head = readFileSync(FILE, "utf8").split("\n").slice(0, 4).join("\n");
  assert.match(head, /@earendil-works\/pi-ai@\d+\.\d+\.\d+/);
  assert.match(head, /合并 sha256=[0-9a-f]{64}/);
  assert.match(head, /MIT License/);
  assert.deepEqual(Object.keys(B).sort(), ["githubCopilotOAuth", "kimiCodingOAuth", "openaiCodexOAuth", "xaiOAuth"]);
});

test("Kimi：设备码登录（先 pending 再成功）、刷新换新令牌、刷新被拒报 unauthorized", async () => {
  let polls = 0;
  routes = {
    "auth.kimi.com /api/oauth/device_authorization": () => ({ json: { device_code: "dc1", user_code: "ABCD-1234", verification_uri: "https://www.kimi.com/code/authorize_device", verification_uri_complete: "https://www.kimi.com/code/authorize_device?user_code=ABCD-1234", interval: 1, expires_in: 60 } }),
    "auth.kimi.com /api/oauth/token": (b) => {
      if (b.get("grant_type") === "refresh_token") return b.get("refresh_token") === "r1" ? { json: { access_token: "a2", refresh_token: "r2", expires_in: 900 } } : { status: 401, json: { error: "invalid_grant" } };
      polls += 1;
      return polls < 2 ? { status: 400, json: { error: "authorization_pending" } } : { json: { access_token: "a1", refresh_token: "r1", expires_in: 900 } };
    },
  };
  const ix = interaction();
  const cred = await B.kimiCodingOAuth.login(ix.it);
  assert.equal(cred.access, "a1"); assert.equal(cred.refresh, "r1");
  assert.equal(ix.events[0].type, "device_code"); assert.equal(ix.events[0].userCode, "ABCD-1234");
  assert.match(ix.events[0].verificationUri, /^https:\/\/www\.kimi\.com\//);
  const next = await B.kimiCodingOAuth.refresh(cred, AbortSignal.timeout(5000));
  assert.equal(next.access, "a2"); assert.equal(next.refresh, "r2");
  assert.deepEqual(await B.kimiCodingOAuth.toAuth(next), { headers: { Authorization: "Bearer a2" } });
  await assert.rejects(B.kimiCodingOAuth.refresh({ ...cred, refresh: "dead" }, AbortSignal.timeout(5000)), /unauthorized/i);
});

test("Grok(xAI)：设备码登录、刷新（不回 refresh_token 时沿用旧的）、刷新被拒报 invalid_grant", async () => {
  routes = {
    "auth.x.ai /oauth2/device/code": () => ({ json: { device_code: "xd", user_code: "XY-12", verification_uri: "https://accounts.x.ai/device", interval: 1, expires_in: 60 } }),
    "auth.x.ai /oauth2/token": (b) => {
      if (b.get("grant_type") === "refresh_token") return b.get("refresh_token") === "xr1" ? { json: { access_token: "xa2", expires_in: 3600 } } : { status: 400, json: { error: "invalid_grant", error_description: "revoked" } };
      return { json: { access_token: "xa1", refresh_token: "xr1", expires_in: 3600 } };
    },
  };
  const ix = interaction();
  const cred = await B.xaiOAuth.login(ix.it);
  assert.equal(cred.access, "xa1");
  assert.equal(ix.events[0].type, "device_code");
  const next = await B.xaiOAuth.refresh(cred, AbortSignal.timeout(5000));
  assert.equal(next.access, "xa2"); assert.equal(next.refresh, "xr1");
  assert.deepEqual(await B.xaiOAuth.toAuth(next), { apiKey: "xa2" });
  await assert.rejects(B.xaiOAuth.refresh({ ...cred, refresh: "dead" }, AbortSignal.timeout(5000)), /invalid_grant/);
});

test("GitHub Copilot：企业域名留空走 github.com，设备码 → GitHub 令牌 → Copilot 令牌（带 proxy-ep）→ 可用模型；刷新、被拒", async () => {
  const copilot = "tid=1;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com;";
  routes = {
    "github.com /login/device/code": () => ({ json: { device_code: "gd", user_code: "GH-1", verification_uri: "https://github.com/login/device", interval: 1, expires_in: 60 } }),
    "github.com /login/oauth/access_token": () => ({ json: { access_token: "gho_1" } }),
    "api.github.com /copilot_internal/v2/token": (_b, req) => (req.headers.authorization === "Bearer gho_1" ? { json: { token: copilot, expires_at: Math.floor(Date.now() / 1000) + 1800 } } : { status: 401, json: { message: "Bad credentials" } }),
    "api.individual.githubcopilot.com /models": () => ({ json: { data: [{ id: "gpt-4.1", model_picker_enabled: true, policy: { state: "enabled" }, capabilities: { supports: { tool_calls: true } } }] } }),
  };
  const ix = interaction({ text: "" });
  const cred = await B.githubCopilotOAuth.login(ix.it);
  assert.equal(cred.refresh, "gho_1"); assert.equal(cred.access, copilot);
  assert.deepEqual(cred.availableModelIds, ["gpt-4.1"]);
  assert.deepEqual(await B.githubCopilotOAuth.toAuth(cred), { apiKey: copilot, baseUrl: "https://api.individual.githubcopilot.com" });
  const next = await B.githubCopilotOAuth.refresh(cred, AbortSignal.timeout(5000));
  assert.equal(next.access, copilot);
  await assert.rejects(B.githubCopilotOAuth.refresh({ ...cred, refresh: "gho_dead" }, AbortSignal.timeout(5000)), /401/);
});

test("Codex：选浏览器登录，粘贴回调地址换令牌（令牌里有 chatgpt_account_id）；刷新、被拒报 401", async () => {
  const access = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } });
  routes = {
    "auth.openai.com /oauth/token": (b) => {
      if (b.get("grant_type") === "refresh_token") return b.get("refresh_token") === "cr1" ? { json: { access_token: access, refresh_token: "cr2", expires_in: 3600 } } : { status: 401, json: { error: "invalid_grant" } };
      return b.get("code") === "good-code" ? { json: { access_token: access, refresh_token: "cr1", expires_in: 3600 } } : { status: 400, json: { error: "bad code" } };
    },
  };
  const ix = interaction({
    select: "browser",
    manual_code: async (_p, events) => {
      const url = new URL(events.find((e) => e.type === "auth_url").url);
      assert.equal(url.hostname, "auth.openai.com");
      assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:1455/auth/callback");
      return `http://localhost:1455/auth/callback?code=good-code&state=${url.searchParams.get("state")}`;
    },
  });
  const cred = await B.openaiCodexOAuth.login(ix.it);
  assert.equal(cred.accountId, "acct-1"); assert.equal(cred.refresh, "cr1");
  const next = await B.openaiCodexOAuth.refresh(cred, AbortSignal.timeout(5000));
  assert.equal(next.refresh, "cr2");
  assert.deepEqual(await B.openaiCodexOAuth.toAuth(next), { apiKey: access });
  await assert.rejects(B.openaiCodexOAuth.refresh({ ...cred, refresh: "dead" }, AbortSignal.timeout(5000)), /401/);
});

test("Codex：state 对不上直接拒绝（防止别人塞回调）", async () => {
  routes = {};
  const ix = interaction({ select: "browser", manual_code: async () => "http://localhost:1455/auth/callback?code=x&state=wrong" });
  await assert.rejects(B.openaiCodexOAuth.login(ix.it), /State mismatch/);
});
