// @意图#R982(2026-11-25): 手动 API key 服务商「从电脑发」运行器侧：
// prepareManual 校验 url（https/非内网，含域名 DNS 解析）；不换鉴权原样透传真 key；原样转发流式回传；key 不落盘；
// 官方套餐互不影响（仍换令牌）；非官方非 hub_ 前缀的未知 provider 仍按白名单拦。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createOfficial } from "../official.mjs";
import { isManualProvider, isPrivateIp, prepareManual } from "../manual.mjs";

const NOW = 1_800_000_000_000;
const SYS = { platform: "darwin", arch: "arm64", release: "24.1.0", node: "v22.9.0" };
const collect = () => { const out = []; return { out, send: (m) => out.push(m) }; };
const fresh = (access = "real-a") => ({ type: "oauth", access, refresh: "real-r", expires: NOW + 3600_000 });
const b64 = (s) => Buffer.from(s).toString("base64");

/** 假的上游：记请求、回 3 段 */
function fakeFetch({ chunks = ["da", "ta:", " ok"], status = 200 } = {}) {
  const reqs = [];
  const fn = async (url, init) => {
    reqs.push({ url, init });
    const enc = new TextEncoder();
    const body = new ReadableStream({
      async pull(ctrl) {
        const c = chunks.shift();
        if (c === undefined) { ctrl.close(); return; }
        ctrl.enqueue(enc.encode(c));
      },
    });
    return new Response(body, { status, headers: { "content-type": "text/event-stream", "content-encoding": "gzip", "content-length": "99", "x-request-id": "rq1" } });
  };
  fn.reqs = reqs;
  return fn;
}

const mkOfficial = (cfg, fetchImpl = fakeFetch(), logs = []) => {
  const saves = [];
  const off = createOfficial(cfg, { save: () => saves.push(JSON.parse(JSON.stringify(cfg.official ?? {}))), fetchImpl, now: () => NOW, sys: SYS, log: (m) => logs.push(m) });
  return { off, saves, fetchImpl };
};

const manualMsg = (over = {}) => ({ type: "model_fetch", id: "m1", provider: "hub_deepseek", url: "https://93.184.216.34/v1/chat/completions", method: "POST",
  headers: [["Authorization", "Bearer real-key-123"], ["x-api-key", "real-key-123"], ["content-type", "application/json"], ["user-agent", "pi (linux 6.8.0; x64)"], ["x-stainless-os", "Linux"], ["content-length", "12"], ["connection", "keep-alive"], ["host", "93.184.216.34"]],
  body: b64('{"hello":1}'), ...over });

test("M1 url 校验：http、localhost、内网 IP、内网域名、带端口、带账号密码、非 url 都拦下（prepareManual 直接判）", async () => {
  const bad = [
    "http://93.184.216.34/v1/chat", // http 不允许
    "https://localhost/v1/chat", // 本机域名
    "https://foo.local/v1/chat", // 内网域名后缀
    "https://127.0.0.1/v1/chat", // 本机 IP
    "https://192.168.1.10/v1/chat", // 内网 IP
    "https://10.0.0.5/v1/chat", // 内网 IP
    "https://93.184.216.34:8443/v1/chat", // 非 443 端口
    "https://u:p@93.184.216.34/v1/chat", // 带账号密码
    "not a url",
  ];
  for (const url of bad) {
    await assert.rejects(() => prepareManual(manualMsg({ url })), (e) => e.code === "blocked", `应当拦下 ${url}`);
  }
  // 合法的公网 IP 字面 + https + 空端口 → 通过（IP 字面不走 DNS）
  const ok = await prepareManual(manualMsg());
  assert.equal(ok.url, "https://93.184.216.34/v1/chat/completions");
});

test("M2 不换鉴权：authorization / x-api-key / cookie 原样透传真值；host/content-length/connection 等连接头去掉；不改指纹", async () => {
  const { init } = await prepareManual(manualMsg());
  assert.equal(init.headers.authorization, "Bearer real-key-123");
  assert.equal(init.headers["x-api-key"], "real-key-123");
  assert.equal(init.headers["content-type"], "application/json");
  // 连接相关头由本机 fetch 自算，不透传
  assert.equal(init.headers.host, undefined);
  assert.equal(init.headers["content-length"], undefined);
  assert.equal(init.headers.connection, undefined);
  // 不改指纹（手动不需要隐藏来源，与官方 rewriteFingerprint 不同）
  assert.equal(init.headers["user-agent"], "pi (linux 6.8.0; x64)");
  assert.equal(init.headers["x-stainless-os"], "Linux");
  assert.equal(init.redirect, "manual");
  assert.equal(Buffer.from(init.body).toString(), '{"hello":1}');
});

test("M3 原样转发：经 createOfficial onMessage（hub_ 前缀）走 manual，fakeFetch 收到真 key 透传、流式回传", async () => {
  const fetchImpl = fakeFetch();
  const { off } = mkOfficial({}, fetchImpl);
  const c = collect();
  await off.onMessage(manualMsg(), c.send);
  const r = fetchImpl.reqs[0];
  assert.ok(r, "应当发出请求");
  assert.equal(r.url, "https://93.184.216.34/v1/chat/completions");
  assert.equal(r.init.headers.authorization, "Bearer real-key-123");
  assert.equal(r.init.headers["x-api-key"], "real-key-123");
  assert.deepEqual(c.out.map((m) => m.type), ["model_head", "model_chunk", "model_chunk", "model_chunk", "model_end"]);
  assert.equal(c.out[0].status, 200);
  assert.equal(c.out.filter((m) => m.type === "model_chunk").map((m) => Buffer.from(m.data, "base64").toString()).join(""), "data: ok");
});

test("M4 key 不落盘：转发后配置无 key、日志无 authorization 值", async () => {
  const fetchImpl = fakeFetch();
  const logs = [];
  const { off, saves } = mkOfficial({}, fetchImpl, logs);
  await off.onMessage(manualMsg(), () => {});
  assert.ok(!JSON.stringify(saves).includes("real-key-123"), "配置写回不含 key");
  assert.ok(!logs.join("\n").includes("real-key-123"), "日志不含 key");
});

test("M5 域名 DNS 检查：解析到内网/保留就拦，公网通过，解析失败拦", async () => {
  const msg = manualMsg({ url: "https://api.deepseek.com/v1/chat/completions" });
  // 解析到内网 → 拦
  await assert.rejects(() => prepareManual(msg, async () => [{ address: "192.168.1.5", family: 4 }]), (e) => e.code === "blocked");
  // 解析到本机 → 拦
  await assert.rejects(() => prepareManual(msg, async () => [{ address: "127.0.0.1", family: 4 }]), (e) => e.code === "blocked");
  // 解析失败 → 拦
  await assert.rejects(() => prepareManual(msg, async () => { throw new Error("ENOTFOUND"); }), (e) => e.code === "blocked");
  // 解析到公网 → 通过
  const ok = await prepareManual(msg, async () => [{ address: "93.184.216.34", family: 4 }]);
  assert.equal(ok.url, "https://api.deepseek.com/v1/chat/completions");
});

test("M6 官方套餐互不影响：kimi-coding 仍走白名单换真令牌（manual 分支不干扰）", async () => {
  const cfg = { official: { "kimi-coding": fresh("kimi-real") } };
  const fetchImpl = fakeFetch();
  const { off } = mkOfficial(cfg, fetchImpl);
  await off.onMessage(manualMsg({ provider: "kimi-coding", url: "https://api.kimi.com/coding/v1/messages" }), () => {});
  const r = fetchImpl.reqs[0];
  assert.equal(r.init.headers.authorization, "Bearer kimi-real"); // 换本机真令牌，不是透传 real-key-123
  assert.equal(r.init.headers["x-api-key"], undefined);
});

test("M7 非官方非 hub_ 前缀的未知 provider 仍按白名单拦，不当 manual 转发", async () => {
  assert.equal(isManualProvider("hub_deepseek"), true);
  assert.equal(isManualProvider("kimi-coding"), false);
  assert.equal(isManualProvider("evil"), false);
  const fetchImpl = fakeFetch();
  const { off } = mkOfficial({}, fetchImpl);
  const c = collect();
  await off.onMessage(manualMsg({ provider: "evil", url: "https://93.184.216.34/v1/chat" }), c.send);
  assert.equal(fetchImpl.reqs.length, 0, "未知 provider 不发请求");
  assert.equal(c.out.at(-1)?.type, "model_error");
});

test("M8 isPrivateIp：内网/本机/保留判 true，公网判 false，fake-ip 段不拦", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.1", "172.16.5.5", "169.254.1.1", "::1", "fd00::1", "fe80::1", "ff02::1", "0.0.0.0"]) {
    assert.equal(isPrivateIp(ip), true, `${ip} 应判内网`);
  }
  for (const ip of ["93.184.216.34", "8.8.8.8", "198.18.0.5", "2606:4700:4700::1111"]) {
    assert.equal(isPrivateIp(ip), false, `${ip} 应判公网/不拦`);
  }
});
