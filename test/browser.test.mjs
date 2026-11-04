// @意图#R729(2026-11-04): bot 专属浏览器（king 同意 R729）：安装先官方后镜像、每个 bot 的资料目录、装没装的检查、
// 后台 ↔ 有窗口切换后登录状态还在、用户关窗口后回到后台、两个 bot 同时用互不干扰、元素清单按编号点击、切换时正在做的那步叫模型重试。
// 真浏览器那几条要一个已经装好的 home：R729_BROWSER_HOME=<装过 browser install 的 AGENT_RUNNER_HOME>，没设就跳过；
// 测试只借它的 browser/ 和 browsers/（软链），资料目录都在临时目录里，「有窗口」用 showWindow:false 不真弹窗。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  browserPkgDir, browsersDir, browserStatus, createBrowserManager, headlessUserAgent, installBrowser, MIRROR_DOWNLOAD_HOST, MIRROR_REGISTRY,
  NOT_INSTALLED, profileDirFor, PW_VERSION, RETRY_TEXT,
} from "../browser.mjs";
import { createSession } from "../runner.mjs";

const tmpHome = () => mkdtempSync(path.join(os.tmpdir(), "r729-home-"));
/** 假装装好：playwright-core 的 package.json / browsers.json、Chromium 目录和完成标记 */
function fakeInstall(home, { version = PW_VERSION, chromium = true } = {}) {
  const pkg = path.join(home, "browser", "node_modules", "playwright-core");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "playwright-core", version }));
  writeFileSync(path.join(pkg, "browsers.json"), JSON.stringify({ browsers: [{ name: "chromium", revision: "9999" }] }));
  writeFileSync(path.join(pkg, "cli.js"), "");
  if (chromium) { mkdirSync(path.join(home, "browsers", "chromium-9999"), { recursive: true }); writeFileSync(path.join(home, "browsers", "chromium-9999", "INSTALLATION_COMPLETE"), ""); }
}

describe("R729 浏览器：安装和检查（不联网）", () => {
  const homes = [];
  after(() => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });

  it("BR1 资料目录按 bot 分在 browser-profiles/<botId>；bot_id 带 / 或 .. 的拒绝", () => {
    const env = { AGENT_RUNNER_HOME: "/x/home" };
    assert.equal(profileDirFor("bot-abc", env), path.join("/x/home", "browser-profiles", "bot-abc"));
    assert.notEqual(profileDirFor("bot-a", env), profileDirFor("bot-b", env));
    for (const bad of ["../x", "a/b", "..", "", "a b"]) assert.throws(() => profileDirFor(bad, env), /bot_id 不合法/);
    assert.equal(browserPkgDir(env), path.join("/x/home", "browser"));
    assert.equal(browsersDir(env), path.join("/x/home", "browsers"));
  });

  it("BR2 browserStatus：没装 / 版本不对 / 没 Chromium / 装好了", () => {
    const h = tmpHome(); homes.push(h); const env = { AGENT_RUNNER_HOME: h };
    assert.deepEqual(browserStatus(env), { installed: false, reason: "no_pkg", version: null });
    fakeInstall(h, { version: "1.0.0", chromium: false });
    assert.equal(browserStatus(env).reason, "version_mismatch");
    fakeInstall(h, { chromium: false });
    assert.equal(browserStatus(env).reason, "no_chromium");
    fakeInstall(h);
    assert.deepEqual(browserStatus(env), { installed: true, reason: null, version: PW_VERSION });
  });

  it("BR3 安装：官方源 npm 失败 → 换 registry.npmmirror.com；官方源 Chromium 失败 → 带 PLAYWRIGHT_DOWNLOAD_HOST 镜像重试", async () => {
    const h = tmpHome(); homes.push(h); const env = { AGENT_RUNNER_HOME: h, PATH: process.env.PATH };
    const calls = [];
    const run = async (cmd, args, o) => {
      calls.push({ cmd, args, env: o.env, timeoutMs: o.timeoutMs });
      const n = calls.length;
      if (n === 1) return { code: 1 }; // 官方 npm 失败
      if (n === 2) { fakeInstall(h, { chromium: false }); return { code: 0 }; } // 镜像 npm 成功
      if (n === 3) return { code: 1 }; // 官方 Chromium 失败
      fakeInstall(h); return { code: 0 }; // 镜像 Chromium 成功
    };
    const used = await installBrowser({ env, run, log: () => {}, platform: "darwin" });
    assert.deepEqual(used, { npm: "mirror", chromium: "mirror" });
    assert.equal(calls[0].cmd, "npm");
    assert.ok(calls[0].args.includes(`playwright-core@${PW_VERSION}`) && calls[0].args.includes(path.join(h, "browser")));
    assert.equal(calls[0].args.includes("--registry"), false);
    assert.deepEqual(calls[1].args.slice(-2), ["--registry", MIRROR_REGISTRY]);
    assert.equal(calls[2].cmd, process.execPath);
    assert.deepEqual(calls[2].args.slice(1), ["install", "--no-shell", "chromium"]);
    assert.equal(calls[2].env.PLAYWRIGHT_BROWSERS_PATH, path.join(h, "browsers"));
    assert.equal(calls[2].env.PLAYWRIGHT_DOWNLOAD_HOST, undefined);
    assert.ok(calls[2].timeoutMs > 0, "官方源下 Chromium 有超时");
    assert.equal(calls[3].env.PLAYWRIGHT_DOWNLOAD_HOST, MIRROR_DOWNLOAD_HOST);
    assert.equal(browserStatus(env).installed, true);
  });

  it("BR4 安装：官方源都成功就不碰镜像；playwright-core 已是对的版本就跳过 npm；官方超时也换镜像；两个源都失败报大白话", async () => {
    const h = tmpHome(); homes.push(h); const env = { AGENT_RUNNER_HOME: h };
    const calls = [];
    let used = await installBrowser({ env, log: () => {}, platform: "darwin", run: async (cmd, args, o) => { calls.push(o.env); if (cmd === "npm") fakeInstall(h, { chromium: false }); else fakeInstall(h); return { code: 0 }; } });
    assert.deepEqual(used, { npm: "official", chromium: "official" });
    assert.equal(calls.length, 2);
    rmSync(path.join(h, "browsers"), { recursive: true, force: true });
    const c2 = [];
    used = await installBrowser({ env, log: () => {}, platform: "darwin", run: async (cmd, args, o) => { c2.push(cmd); if (c2.length === 1) return { code: -1, timedOut: true }; fakeInstall(h); return { code: 0 }; } });
    assert.deepEqual(c2, [process.execPath, process.execPath], "npm 跳过，Chromium 官方超时后镜像");
    assert.equal(used.chromium, "mirror");
    const h2 = tmpHome(); homes.push(h2);
    await assert.rejects(installBrowser({ env: { AGENT_RUNNER_HOME: h2 }, log: () => {}, platform: "darwin", run: async () => ({ code: 1 }) }), /官方源和镜像都失败了/);
  });

  it("BR5 Windows 上 npm 用 npm.cmd", async () => {
    const h = tmpHome(); homes.push(h);
    const cmds = [];
    await installBrowser({ env: { AGENT_RUNNER_HOME: h }, log: () => {}, platform: "win32", run: async (cmd) => { cmds.push(cmd); fakeInstall(h); return { code: 0 }; } });
    assert.equal(cmds[0], "npm.cmd");
  });

  it("BR6 没装时 bot 用浏览器：回「请主人运行 … browser install」，不去加载 playwright", async () => {
    const h = tmpHome(); homes.push(h);
    let loaded = false;
    const m = createBrowserManager({ env: { AGENT_RUNNER_HOME: h }, load: () => { loaded = true; throw new Error("不该加载"); } });
    await assert.rejects(m.run("bot-a", "open", { url: "https://example.com" }), (e) => e.message === NOT_INSTALLED());
    assert.match(NOT_INSTALLED(), /browser install/);
    assert.equal(loaded, false);
    await assert.rejects(m.run("../x", "look"), /bot_id 不合法/);
  });

  // @意图#R730(2026-11-04): 没装浏览器时网页点「打开 bot 的浏览器」：只回错误，不能留下未处理的 rejection 把 runner 进程退掉
  it("BR12 没装时点打开浏览器：回错误、没有未处理的 rejection、之后还能再调", async () => {
    const h = tmpHome(); homes.push(h);
    // 真实的 loadPlaywright 没装时会抛 NOT_INSTALLED，这里模拟同样的抛法
    const m = createBrowserManager({ env: { AGENT_RUNNER_HOME: h }, load: () => { throw new Error(NOT_INSTALLED()); } });
    const unhandled = [];
    const onUnhandled = (e) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      await assert.rejects(m.openHeaded("bot-a"), (e) => e.message === NOT_INSTALLED());
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(unhandled.length, 0, "不能有未处理的 rejection");
      await assert.rejects(m.openHeaded("bot-a"), (e) => e.message === NOT_INSTALLED());
      await assert.rejects(m.run("bot-a", "open", { url: "https://example.com" }), (e) => e.message === NOT_INSTALLED());
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(unhandled.length, 0);
    } finally { process.off("unhandledRejection", onUnhandled); }
  });

  // @意图#R729(2026-11-04): 真机验收时百度对 HeadlessChrome 跳验证码，无头模式改用普通 Chrome 的 UA（主版本号跟着装好的 Chromium）
  it("BR11 无头用的 User-Agent：不带 Headless，主版本号来自 browsers.json，按平台写系统", () => {
    const h = tmpHome(); homes.push(h);
    fakeInstall(h);
    const pkg = path.join(h, "browser", "node_modules", "playwright-core", "browsers.json");
    writeFileSync(pkg, JSON.stringify({ browsers: [{ name: "chromium", revision: "9999", browserVersion: "156.0.8078.4" }] }));
    const env = { AGENT_RUNNER_HOME: h };
    assert.equal(headlessUserAgent(env, "darwin"), "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36");
    assert.match(headlessUserAgent(env, "win32"), /Windows NT 10\.0; Win64; x64.*Chrome\/156\.0\.0\.0/);
    assert.match(headlessUserAgent(env, "linux"), /X11; Linux x86_64/);
    for (const p of ["darwin", "win32", "linux"]) assert.doesNotMatch(headlessUserAgent(env, p), /Headless/i);
  });
});

describe("R729 运行器转发浏览器消息", () => {
  it("BR10 browser / browser_open 交给浏览器管理器，不看这个 bot 有没有选目录；出错回 ok:false + 原话；缺 bot_id 拒绝", async () => {
    const seen = [];
    const fake = {
      async run(bot, action, args) { seen.push(["run", bot, action, args]); if (action === "boom") throw new Error("炸了"); return { kind: "elements", text: "清单", url: "u", title: "t" }; },
      async openHeaded(bot) { seen.push(["open", bot]); return { ok: true, already: false, urls: ["https://a"] }; },
      async closeAll() {},
    };
    const s = createSession({ bot_dirs: {} }, { log: () => {}, browser: fake, file: path.join(os.tmpdir(), "r729-nofile.json") });
    const out = [];
    await s.onMessage({ type: "browser", id: "1", bot_id: "bot-x", action: "open", args: { url: "https://a" } }, (m) => out.push(m));
    await s.onMessage({ type: "browser", id: "2", bot_id: "bot-x", action: "boom", args: {} }, (m) => out.push(m));
    await s.onMessage({ type: "browser_open", id: "3", bot_id: "bot-x" }, (m) => out.push(m));
    await s.onMessage({ type: "browser", id: "4", action: "look" }, (m) => out.push(m));
    assert.deepEqual(out[0], { type: "result", id: "1", ok: true, kind: "elements", text: "清单", url: "u", title: "t" });
    assert.deepEqual(out[1], { type: "result", id: "2", ok: false, error: "炸了" });
    assert.deepEqual(out[2], { type: "result", id: "3", ok: true, bot_id: "bot-x", already: false, urls: ["https://a"] });
    assert.equal(out[3].ok, false);
    assert.deepEqual(seen.map((x) => x[0]), ["run", "run", "open"]);
  });
});

const REAL = process.env.R729_BROWSER_HOME;
describe("R729 浏览器：真 Chromium（本地测试页）", { skip: !REAL || !browserStatus({ AGENT_RUNNER_HOME: REAL }).installed ? "没设 R729_BROWSER_HOME（装好浏览器的 home）" : false }, () => {
  let home; let env; let srv; let base; let m;
  before(async () => {
    home = tmpHome(); env = { AGENT_RUNNER_HOME: home };
    symlinkSync(path.join(REAL, "browser"), path.join(home, "browser"));
    symlinkSync(path.join(REAL, "browsers"), path.join(home, "browsers"));
    srv = createServer((req, res) => {
      const logged = /(?:^|;\s*)sid=ok/.test(req.headers.cookie ?? "");
      if (req.url === "/login") { res.writeHead(200, { "set-cookie": "sid=ok; Path=/; Max-Age=86400", "content-type": "text/html; charset=utf-8" }); res.end("<title>登录</title><p>登录成功</p>"); return; }
      if (req.url === "/jump") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end("<title>跳</title><script>location.href='/'</script>"); return; }
      if (req.url === "/jump-late") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end("<title>晚跳</title><button onclick=\"setTimeout(()=>location.href='/',30)\">走</button>"); return; }
      if (req.url === "/slow") { setTimeout(() => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end("<title>慢</title>慢页面"); }, 4000); return; }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<title>首页</title><p id="st">${logged ? "已登录" : "未登录"}</p><button onclick="document.getElementById('r').textContent='点到了'">点我</button><p id="r">还没点</p><input placeholder="写点什么">`);
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${srv.address().port}`;
    m = createBrowserManager({ env, showWindow: false });
  });
  after(async () => { await m?.closeAll(); srv?.close(); rmSync(home, { recursive: true, force: true }); });

  const text = (r) => String(r.text ?? "");

  it("BR7 后台打开：元素清单带编号；按编号点按钮、按编号输入；截图是 JPEG", async () => {
    let r = await m.run("bot-a", "open", { url: `${base}/` });
    assert.equal(r.kind, "elements");
    assert.equal(m.mode("bot-a"), "headless");
    assert.match(text(r), /未登录/);
    const btn = /\[(\d+)\] 按钮 "点我"/.exec(text(r));
    assert.ok(btn, text(r));
    r = await m.run("bot-a", "click_ref", { ref: Number(btn[1]) });
    assert.match(text(r), /点到了/);
    const inp = /\[(\d+)\] 输入框 提示="写点什么"/.exec(text(r));
    r = await m.run("bot-a", "type", { ref: Number(inp[1]), text: "你好" });
    assert.match(text(r), /值="你好"/);
    await assert.rejects(m.run("bot-a", "click_ref", { ref: 999 }), /没有编号 \[999\]/);
    r = await m.run("bot-a", "look", { view: "image" });
    assert.equal(r.kind, "image");
    assert.equal(r.mime, "image/jpeg");
    assert.equal(Buffer.from(r.data, "base64").subarray(0, 2).toString("hex"), "ffd8");
    assert.ok(existsSync(profileDirFor("bot-a", env)));
  });

  it("BR8 登录后 后台 → 有窗口（恢复网址）→ 用户关窗口 → 再用回到后台：cookie 一直在；另一个 bot 没登录、能同时用", async () => {
    await m.run("bot-a", "open", { url: `${base}/login` });
    await m.run("bot-a", "open", { url: `${base}/` });
    const [opened, other] = await Promise.all([m.openHeaded("bot-a"), m.run("bot-b", "open", { url: `${base}/` })]);
    assert.equal(m.mode("bot-a"), "headed");
    assert.deepEqual(opened.urls, [`${base}/`]);
    assert.match(text(other), /未登录/, "bot-b 的资料目录是自己的");
    let r = await m.run("bot-a", "look");
    assert.equal(r.url, `${base}/`, "恢复了原来的网址");
    assert.match(text(r), /已登录/);
    assert.equal((await m.openHeaded("bot-a")).already, true, "已经有窗口就不重开");
    await m._contextOf("bot-a").close(); // 用户关掉窗口
    assert.equal(m.mode("bot-a"), null);
    r = await m.run("bot-a", "open", { url: `${base}/` });
    assert.equal(m.mode("bot-a"), "headless");
    assert.match(text(r), /已登录/);
    assert.equal(m.mode("bot-b"), "headless");
  });

  it("BR9 bot 正在做的一步撞上「打开浏览器」：这一步回 RETRY_TEXT，之后照常能用（同一个有窗口的实例）", async () => {
    await m.run("bot-c", "open", { url: `${base}/` });
    const slow = m.run("bot-c", "open", { url: `${base}/slow` }).then(() => null, (e) => e);
    await new Promise((r) => setTimeout(r, 500));
    await m.openHeaded("bot-c");
    assert.equal((await slow)?.message, RETRY_TEXT);
    const r = await m.run("bot-c", "look");
    assert.equal(m.mode("bot-c"), "headed");
    assert.ok(r.url.startsWith(base));
    const closed = await m.run("bot-c", "close");
    assert.match(closed.text, /关掉了/);
    assert.equal(m.mode("bot-c"), null);
  });

  // @意图#R729(2026-11-04): 真机验收时按回车搜索后读元素报 Execution context was destroyed；页面自己跳转时要等稳了再读
  it("BR12 网页自己跳转（打开时马上跳、点了以后跳）：不报错，读到的是跳到的那一页；后台模式 UA 不带 Headless", async () => {
    let r = await m.run("bot-j", "open", { url: `${base}/jump` });
    assert.equal(r.title, "首页");
    r = await m.run("bot-j", "open", { url: `${base}/jump-late` });
    const ref = /^\[(\d+)\] 按钮 "走"/m.exec(text(r))?.[1];
    assert.ok(ref, text(r));
    r = await m.run("bot-j", "click_ref", { ref });
    if (r.title !== "首页") r = await m.run("bot-j", "look");
    assert.equal(r.title, "首页");
    const ua = await m._contextOf("bot-j").pages()[0].evaluate(() => navigator.userAgent);
    assert.doesNotMatch(ua, /Headless/i);
  });
});
