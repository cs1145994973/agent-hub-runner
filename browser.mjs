// @意图#R729(2026-11-04): bot 专属浏览器（king 同意 R729，方案里最初记作 R726）。每个 bot 在用户电脑上有一只自己的 Chromium，
// 和用户平时用的 Chrome 完全分开；登录状态按 bot 存在 ~/.agent-runner/browser-profiles/<botId>/，多个 bot 能同时各用各的。
// 运行器本身仍然零依赖（king 定乙）：playwright-core 和 Chromium 只在用户运行 `agent-hub-runner browser install` 时才装进
// ~/.agent-runner/browser/ 和 ~/.agent-runner/browsers/，用到时按绝对路径动态加载；没装、版本不对都回大白话。
// bot 操作时默认后台跑（不显示窗口）；网页上点「打开 bot 的浏览器」时换成有窗口的，bot 和用户共用这个窗口；用户关掉窗口后 bot 下次操作回到后台。
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { runnerHome } from "./autostart.mjs";

/** 装哪个版本的 playwright-core（钉死；换版本要一起改这里、测试和文档） */
export const PW_VERSION = "1.64.1";
/** 官方源失败后换的国内镜像 */
export const MIRROR_REGISTRY = "https://registry.npmmirror.com";
export const MIRROR_DOWNLOAD_HOST = "https://cdn.npmmirror.com/binaries/playwright";
/** 官方源下载 Chromium 最多等多久，超过就当失败换镜像（官方源在国内常常很慢） */
export const OFFICIAL_TIMEOUT_MS = 10 * 60_000;
/** 后台（无窗口）浏览器多久没人用就关掉 */
export const IDLE_CLOSE_MS = 10 * 60_000;
/** 元素清单最多列多少个、页面文字最多带多少字 */
export const MAX_ELEMENTS = 150;
export const MAX_PAGE_TEXT = 2000;
/** 后台模式的页面大小（截图就是这么大） */
export const HEADLESS_VIEWPORT = { width: 1280, height: 800 };

export const browserPkgDir = (env = process.env) => path.join(runnerHome(env), "browser");
export const browsersDir = (env = process.env) => path.join(runnerHome(env), "browsers");
export const profilesDir = (env = process.env) => path.join(runnerHome(env), "browser-profiles");

/** 装浏览器的命令（提示里用） */
export const installCmd = (prog = "agent-hub-runner") => `${prog} browser install`;
// @意图#R729(2026-11-04): 没装 / 版本不对时 bot 和网页看到的话：直接给命令，用户复制到终端运行就行
export const NOT_INSTALLED = (prog = "npx -y agent-hub-runner@latest") =>
  `这台电脑还没装 bot 专用的浏览器。请主人在电脑终端里运行：${installCmd(prog)}（会下载 playwright-core 和一只独立的 Chromium，约 200MB，只要装一次）`;
export const VERSION_MISMATCH = (have, prog = "npx -y agent-hub-runner@latest") =>
  `电脑上装的浏览器组件版本（${have}）和运行器要的（${PW_VERSION}）不一样。请主人在电脑终端里重新运行：${installCmd(prog)}`;
export const RETRY_TEXT = "浏览器刚换成了有窗口的模式（主人点了「打开 bot 的浏览器」），这一步没做完，请重试这一步。";
export const CLOSED_BY_USER = "浏览器窗口被关掉了，这一步没做完，请重试这一步（会在后台重新打开）。";

/** 这个 bot 的资料目录。bot_id 只认字母、数字、点、下划线、横线（防止拼出别的路径）。 */
// @意图#R729(2026-11-04): 每个 bot 一份资料目录（登录信息、cookie 都在这里，关掉再开还在），互不相干
export function profileDirFor(botId, env = process.env) {
  if (typeof botId !== "string" || !/^[A-Za-z0-9._-]{1,100}$/.test(botId) || botId === "." || botId === "..") throw new Error(`bot_id 不合法：${String(botId)}`);
  return path.join(profilesDir(env), botId);
}

/** 不加载 playwright，只看文件：装没装、版本对不对、Chromium 在不在。 */
// @意图#R729(2026-11-04): 心跳里报给服务器（网页抽屉显示「未安装」），也在每次用浏览器前先查一遍
export function browserStatus(env = process.env) {
  const pkg = path.join(browserPkgDir(env), "node_modules", "playwright-core", "package.json");
  let version = null;
  try { version = String(JSON.parse(readFileSync(pkg, "utf8")).version); } catch { return { installed: false, reason: "no_pkg", version: null }; }
  if (version !== PW_VERSION) return { installed: false, reason: "version_mismatch", version };
  const dir = chromiumDir(env);
  if (!dir || !existsSync(path.join(dir, "INSTALLATION_COMPLETE"))) return { installed: false, reason: "no_chromium", version };
  return { installed: true, reason: null, version };
}

/** 装好的 playwright-core 自带的 browsers.json 里 chromium 那一项（版本号目录、浏览器版本） */
function chromiumEntry(env) {
  try {
    const j = JSON.parse(readFileSync(path.join(browserPkgDir(env), "node_modules", "playwright-core", "browsers.json"), "utf8"));
    return (j.browsers ?? []).find((b) => b.name === "chromium") ?? null;
  } catch { return null; }
}
/** Chromium 应该装在哪（按 browsers.json 算出版本号目录） */
function chromiumDir(env) {
  const c = chromiumEntry(env);
  return c?.revision ? path.join(browsersDir(env), `chromium-${c.revision}`) : null;
}

/**
 * 后台（无头）模式用的 User-Agent：和有窗口的 Chrome 一样，不带 HeadlessChrome。
 * 不这么做百度等网站一搜就跳验证码（2026-11-04 真机验收时遇到）。这不是过验证码，只是别自报「我是无头浏览器」。
 */
// @意图#R729(2026-11-04): 真机验收发现百度对 HeadlessChrome 的 UA 直接跳图形验证码；无头时按平台 + 钉死的 Chromium 主版本号给一个普通 Chrome 的 UA
export function headlessUserAgent(env = process.env, platform = process.platform) {
  const major = String(chromiumEntry(env)?.browserVersion ?? "").split(".")[0] || "156";
  const os = platform === "darwin" ? "Macintosh; Intel Mac OS X 10_15_7" : platform === "win32" ? "Windows NT 10.0; Win64; x64" : "X11; Linux x86_64";
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/** 没装好就抛大白话 */
export function ensureInstalled(env = process.env, prog) {
  const st = browserStatus(env);
  if (st.installed) return st;
  if (st.reason === "version_mismatch") throw new Error(VERSION_MISMATCH(st.version, prog));
  throw new Error(NOT_INSTALLED(prog));
}

/** 跑一个命令，输出原样转给终端；返回退出码。timeoutMs 到了杀掉、算失败。 */
function runCmd(cmd, args, { env, timeoutMs, platform = process.platform } = {}) {
  return new Promise((resolve) => {
    const win = platform === "win32";
    // Windows 上 npm 是 npm.cmd，新版 Node 要 shell 才能跑 .cmd；参数里的路径加引号
    const child = spawn(cmd, win ? args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)) : args, { env, stdio: "inherit", shell: win });
    let timer;
    if (timeoutMs) timer = setTimeout(() => { try { child.kill(); } catch { /* 已经退出 */ } resolve({ code: -1, timedOut: true }); }, timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, error: e }); });
    child.on("exit", (code) => { clearTimeout(timer); resolve({ code: code ?? -1 }); });
  });
}

/**
 * agent-hub-runner browser install：先把 playwright-core 装进 ~/.agent-runner/browser/，再把 Chromium 下到 ~/.agent-runner/browsers/。
 * 两步都是先官方源，失败（或官方下 Chromium 超过 10 分钟）再换国内镜像。返回每一步用的是哪个源。
 */
// @意图#R729(2026-11-04): king 定：先官方、失败再镜像（npm 用 registry.npmmirror.com，Chromium 用 cdn.npmmirror.com 的 playwright 镜像）；
// 只装 Chromium 本体（--no-shell，不另下 headless shell），后台模式也用它（channel: "chromium"），有窗口和后台共用同一只浏览器、同一份资料目录
export async function installBrowser({ env = process.env, log = console.log, run = runCmd, platform = process.platform, officialTimeoutMs = OFFICIAL_TIMEOUT_MS } = {}) {
  const dir = browserPkgDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const pj = path.join(dir, "package.json");
  if (!existsSync(pj)) writeFileSync(pj, `${JSON.stringify({ name: "agent-hub-runner-browser", private: true, description: "agent-hub-runner browser install 装的浏览器组件" }, null, 2)}\n`);
  const npm = platform === "win32" ? "npm.cmd" : "npm";
  const npmArgs = ["install", "--no-audit", "--no-fund", "--save-exact", "--prefix", dir, `playwright-core@${PW_VERSION}`];
  const used = { npm: "official", chromium: "official" };
  const st = browserStatus(env);
  if (st.version === PW_VERSION) log(`playwright-core ${PW_VERSION} 已经装过，跳过。`);
  else {
    log(`第 1 步：装 playwright-core ${PW_VERSION}（官方源）……`);
    let r = await run(npm, npmArgs, { env, platform });
    if (r.code !== 0) {
      log("官方源没装成，换国内镜像 registry.npmmirror.com 再试……");
      used.npm = "mirror";
      r = await run(npm, [...npmArgs, "--registry", MIRROR_REGISTRY], { env, platform });
      if (r.code !== 0) throw new Error("playwright-core 没装成（官方源和镜像都失败了）。检查网络后再运行一次同一条命令。");
    }
  }
  const cli = path.join(dir, "node_modules", "playwright-core", "cli.js");
  if (!existsSync(cli)) throw new Error(`装完了却找不到 ${cli}，请再运行一次同一条命令。`);
  const pwEnv = { ...env, PLAYWRIGHT_BROWSERS_PATH: browsersDir(env) };
  const args = [cli, "install", "--no-shell", "chromium"];
  log(`第 2 步：下载 Chromium 到 ${browsersDir(env)}（官方源，约 200MB）……`);
  let r = await run(process.execPath, args, { env: pwEnv, platform, timeoutMs: officialTimeoutMs });
  if (r.code !== 0) {
    log(r.timedOut ? `官方源 ${Math.round(officialTimeoutMs / 60_000)} 分钟还没下完，换国内镜像再试……` : "官方源没下成，换国内镜像 cdn.npmmirror.com 再试……");
    used.chromium = "mirror";
    r = await run(process.execPath, args, { env: { ...pwEnv, PLAYWRIGHT_DOWNLOAD_HOST: MIRROR_DOWNLOAD_HOST }, platform });
    if (r.code !== 0) throw new Error("Chromium 没下成（官方源和镜像都失败了）。检查网络后再运行一次同一条命令。");
  }
  const after = browserStatus(env);
  if (!after.installed) throw new Error("下载完了但检查没通过，请再运行一次同一条命令。");
  log(`装好了：playwright-core ${PW_VERSION}（${used.npm === "mirror" ? "镜像" : "官方源"}），Chromium（${used.chromium === "mirror" ? "镜像" : "官方源"}）。bot 现在能用浏览器了，运行器不用重启。`);
  return used;
}

/** 按绝对路径加载 ~/.agent-runner/browser/ 里的 playwright-core（运行器自己不依赖它）。 */
// @意图#R729(2026-11-04): 乙：用到时才加载；PLAYWRIGHT_BROWSERS_PATH 要在第一次加载前设好（它在加载时读）
export function loadPlaywright(env = process.env, prog) {
  ensureInstalled(env, prog);
  process.env.PLAYWRIGHT_BROWSERS_PATH = browsersDir(env);
  const req = createRequire(path.join(browserPkgDir(env), "package.json"));
  return req("playwright-core");
}

/** 页面正在跳转时读页面会碰到的错误（等一下再读就好） */
const NAV_RACE = /Execution context was destroyed|interrupted by another navigation|Cannot find context with specified id|frame was detached|navigat(ing|ion).*(changed|interrupted)/i;

// ---- 页面里跑的两段（序列化后在浏览器里执行，不能引用外面的变量） ----
/** 找出页面上能点、能填的元素（看得见的），最多 max 个 */
function collectElements(max) {
  const sel = "a[href],button,input:not([type=hidden]),textarea,select,summary,[role=button],[role=link],[role=textbox],[role=searchbox],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=combobox],[contenteditable=''],[contenteditable=true],[onclick]";
  const out = [];
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.display === "none" || Number(s.opacity) === 0) continue;
    if (r.bottom < -200 || r.top > innerHeight * 3) continue;
    out.push(el);
    if (out.length >= max) break;
  }
  return out;
}
/** 一个元素的一行说明 */
function describeElements(els) {
  const cut = (t, n) => { const x = String(t ?? "").replace(/\s+/g, " ").trim(); return x.length > n ? `${x.slice(0, n)}…` : x; };
  return els.map((el) => {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role") || "";
    const type = (el.getAttribute("type") || "").toLowerCase();
    const r = el.getBoundingClientRect();
    let kind = role || tag;
    if (tag === "a") kind = "链接";
    else if (tag === "button" || role === "button" || type === "submit" || type === "button") kind = "按钮";
    else if (tag === "input" && (type === "checkbox" || type === "radio")) kind = type === "checkbox" ? "勾选框" : "单选";
    else if (tag === "input" || tag === "textarea" || role === "textbox" || role === "searchbox" || el.isContentEditable) kind = "输入框";
    else if (tag === "select" || role === "combobox") kind = "下拉框";
    const text = cut(el.innerText || el.textContent, 60);
    const label = cut(el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("alt"), 40);
    const ph = cut(el.getAttribute("placeholder"), 40);
    const val = tag === "input" && type !== "password" && type !== "checkbox" && type !== "radio" ? cut(el.value, 40) : "";
    const href = tag === "a" ? cut(el.getAttribute("href"), 80) : "";
    const parts = [kind];
    if (text) parts.push(`"${text}"`);
    if (label && label !== text) parts.push(`标签="${label}"`);
    if (ph) parts.push(`提示="${ph}"`);
    if (val) parts.push(`值="${val}"`);
    if (type === "password") parts.push("(密码框)");
    if ((type === "checkbox" || type === "radio") && el.checked) parts.push("(已勾)");
    if (href && !href.startsWith("javascript")) parts.push(`→ ${href}`);
    parts.push(`@(${Math.round(r.left + r.width / 2)},${Math.round(r.top + r.height / 2)})`);
    return parts.join(" ");
  });
}

/**
 * 每个 bot 一只浏览器（launchPersistentContext，资料目录按 bot 分）。bot 的操作按 bot 排队一个一个做；
 * 网页点「打开」不排队，直接把后台的换成有窗口的（正在做的那一步会失败一次，叫模型重试）。
 */
// @意图#R729(2026-11-04): king 定的几条：默认后台跑、点按钮才显示；撞上时弹出同一个窗口一起看（后台实例关掉、同一份资料目录重开有窗口的、恢复打开的网址）；
// 用户关掉窗口后下次操作回到后台；后台的 10 分钟没人用就关；浏览器操作全部自动允许（这里不管批准）
// showWindow=false 只给测试用：「有窗口」模式照样走切换逻辑，但实际不弹窗口
export function createBrowserManager({ env = process.env, log = () => {}, idleMs = IDLE_CLOSE_MS, load = () => loadPlaywright(env), prog, showWindow = true } = {}) {
  /** botId → { ctx, headed, page, refs, gen, timer } */
  const bots = new Map();
  /** botId → 正在开 / 换模式的 Promise（同一个 bot 同时只开一次） */
  const opening = new Map();
  /** botId → 操作队列的尾巴 */
  const queues = new Map();
  let gen = 0;

  const arm = (botId, e) => {
    clearTimeout(e.timer);
    if (e.headed) return; // 有窗口的由用户关，不自动关
    e.timer = setTimeout(() => { if (bots.get(botId) === e) { log(`[${botId}] 浏览器 ${Math.round(idleMs / 60_000)} 分钟没用，关掉了`); void closeEntry(botId, e); } }, idleMs);
    e.timer.unref?.();
  };
  async function closeEntry(botId, e) {
    clearTimeout(e.timer);
    if (bots.get(botId) === e) bots.delete(botId);
    await e.ctx.close().catch(() => {});
  }

  async function launch(botId, headed, urls = []) {
    const pw = load();
    const dir = profileDirFor(botId, env);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    let ctx;
    try {
      ctx = await pw.chromium.launchPersistentContext(dir, {
        channel: "chromium", headless: !(headed && showWindow), viewport: headed ? null : HEADLESS_VIEWPORT,
        locale: "zh-CN", args: headed ? ["--start-maximized"] : [],
        ...(headed && showWindow ? {} : { userAgent: headlessUserAgent(env) }),
      });
    } catch (e) {
      const m = String(e?.message ?? e);
      if (/ProcessSingleton|SingletonLock|profile.*in use|already in use/i.test(m)) throw new Error("这个 bot 的浏览器资料目录正被另一只浏览器占着（可能是上次没关干净），先把那个 Chromium 窗口关掉再试。");
      throw new Error(`浏览器没打开：${m.split("\n")[0]}`);
    }
    const e = { ctx, headed, page: null, refs: [], gen: ++gen, timer: undefined };
    ctx.on("page", (p) => { if (bots.get(botId) === e) e.page = p; }); // 点了链接开新标签页：跟过去
    ctx.on("close", () => { if (bots.get(botId) === e) { clearTimeout(e.timer); bots.delete(botId); if (e.headed) log(`[${botId}] 浏览器窗口关掉了，之后 bot 用浏览器会在后台打开`); } });
    bots.set(botId, e);
    const pages = ctx.pages();
    for (let i = 0; i < urls.length; i++) {
      const p = i < pages.length ? pages[i] : await ctx.newPage();
      await p.goto(urls[i], { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
      e.page = p;
    }
    if (!e.page) e.page = ctx.pages()[0] ?? await ctx.newPage();
    arm(botId, e);
    return e;
  }

  /** 拿到这个 bot 的浏览器（没有就后台开一只） */
  async function get(botId) {
    const cur = bots.get(botId);
    if (cur) return cur;
    if (opening.has(botId)) return opening.get(botId);
    const p = launch(botId, false).finally(() => opening.delete(botId));
    opening.set(botId, p);
    return p;
  }

  /** 网页点「打开 bot 的浏览器」：换成 / 打开有窗口的 */
  // @意图#R730(2026-11-04): 打开失败只把错误回给网页，runner 不能因此崩掉
  async function openHeaded(botId) {
    if (opening.has(botId)) await opening.get(botId).catch(() => {});
    const cur = bots.get(botId);
    if (cur?.headed) { await cur.page?.bringToFront().catch(() => {}); return { ok: true, already: true, urls: cur.ctx.pages().map((p) => p.url()) }; }
    const run = (async () => {
      let urls = [];
      if (cur) {
        urls = cur.ctx.pages().map((p) => p.url()).filter((u) => u && u !== "about:blank");
        log(`[${botId}] 网页上点了打开浏览器：后台的先关掉，换成有窗口的（恢复 ${urls.length} 个网页）`);
        await closeEntry(botId, cur);
      } else log(`[${botId}] 网页上点了打开浏览器`);
      const e = await launch(botId, true, urls);
      await e.page?.bringToFront().catch(() => {});
      return { ok: true, already: false, urls };
    })().finally(() => opening.delete(botId));
    // @意图#R730(2026-11-04): 存进 opening 的是 run 派生出来的 promise。run 失败（没装浏览器、启动出错）时，没人 await 它就成了
    // 未处理的 rejection，Node 会把整个 runner 进程退掉，网页上显示离线。挂一个空 catch 标成已处理；别人 await 它照样拿到错误。
    const waiting = run.then(() => bots.get(botId));
    waiting.catch(() => {});
    opening.set(botId, waiting);
    return run;
  }

  function currentPage(e) {
    if (e.page && !e.page.isClosed()) return e.page;
    const ps = e.ctx.pages();
    e.page = ps[ps.length - 1] ?? null;
    return e.page;
  }

  async function settle(page) {
    await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
    await page.waitForLoadState("load", { timeout: 3_000 }).catch(() => {});
    await page.waitForTimeout(300).catch(() => {});
  }

  // @意图#R729(2026-11-04): 真机验收发现：按回车搜索、网页自己跳转时，刚好在跳的那一下读元素会报 Execution context was destroyed；
  // 碰到跳转类错误就等页面稳住再读，最多 3 次
  async function observe(e, page, view) {
    for (let i = 0; ; i++) {
      try {
        const head = { url: page.url(), title: await page.title().catch(() => ""), headed: e.headed };
        if (view === "image") {
          const buf = await page.screenshot({ type: "jpeg", quality: 60, timeout: 15_000 });
          return { kind: "image", mime: "image/jpeg", data: buf.toString("base64"), ...head };
        }
        return { kind: "elements", text: await elementsText(e, page), ...head };
      } catch (err) {
        if (i >= 2 || !NAV_RACE.test(String(err?.message ?? err))) throw err;
        await settle(page);
        page = currentPage(e) ?? page;
      }
    }
  }

  async function elementsText(e, page) {
    for (const h of e.refs) await h.dispose().catch(() => {});
    e.refs = [];
    const arr = await page.evaluateHandle(collectElements, MAX_ELEMENTS);
    const lines = await arr.evaluate(describeElements);
    for (let i = 0; i < lines.length; i++) {
      const h = await arr.getProperty(String(i));
      e.refs.push(h.asElement() ?? h);
    }
    await arr.dispose().catch(() => {});
    const body = await page.evaluate(() => (document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n").trim()).catch(() => "");
    const text = body.length > MAX_PAGE_TEXT ? `${body.slice(0, MAX_PAGE_TEXT)}…（后面还有 ${body.length - MAX_PAGE_TEXT} 字，滚动后再看）` : body;
    return `可操作的元素（[编号] 类型 文字 @(中心坐标)；点击 / 输入用编号）：\n${lines.map((l, i) => `[${i + 1}] ${l}`).join("\n") || "（没找到）"}\n\n页面文字：\n${text || "（空）"}`;
  }

  function refOf(e, ref) {
    const n = Number(ref);
    const h = Number.isInteger(n) && n >= 1 ? e.refs[n - 1] : undefined;
    if (!h) throw new Error(`没有编号 [${String(ref)}]：编号只在最近一次返回的元素清单里有效，先用 snapshot 拿新清单`);
    return h;
  }

  const num = (v, name) => { const n = Number(v); if (!Number.isFinite(n)) throw new Error(`${name} 要是数字`); return n; };

  async function act(e, action, a) {
    if (action === "close") { await closeEntry(a.__bot, e); return { kind: "text", text: "浏览器关掉了（登录状态还在，下次用会重新打开）" }; }
    let page = currentPage(e) ?? await e.ctx.newPage();
    e.page = page;
    switch (action) {
      case "open": {
        const url = String(a.url ?? "").trim();
        if (!url) throw new Error("open 要给 url");
        const full = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
        if (!/^(https?|file|about|data):/i.test(full)) throw new Error(`不支持的网址：${url}`);
        // 网页自己又跳了一次（重定向到登录页、验证页）不算失败，下面照常读跳到的那一页
        await page.goto(full, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch((err) => { if (!NAV_RACE.test(String(err?.message ?? err))) throw err; });
        break;
      }
      case "look": case "screenshot": case "snapshot": break;
      case "click": await page.mouse.click(num(a.x, "x"), num(a.y, "y")); break;
      case "click_ref": await refOf(e, a.ref).click({ timeout: 10_000 }); break;
      case "type": {
        const text = String(a.text ?? "");
        if (a.ref !== undefined && a.ref !== null && a.ref !== "") {
          await refOf(e, a.ref).click({ timeout: 10_000 });
          await page.keyboard.press("ControlOrMeta+A");
        }
        await page.keyboard.type(text, { delay: 25 });
        break;
      }
      case "press": await page.keyboard.press(String(a.key ?? "Enter")); break;
      case "scroll": await page.mouse.wheel(Number(a.dx ?? 0) || 0, a.dy === undefined ? 600 : num(a.dy, "dy")); break;
      case "back": await page.goBack({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => null); break;
      default: throw new Error(`不认识的浏览器动作：${action}`);
    }
    if (action !== "look" && action !== "screenshot" && action !== "snapshot") await settle(currentPage(e) ?? page);
    page = currentPage(e) ?? page;
    const view = action === "snapshot" ? "elements" : a.view === "image" ? "image" : "elements";
    return observe(e, page, view);
  }

  /** bot 的一步操作。同一个 bot 的操作排队；中途被网页「打开」换了模式就回 RETRY_TEXT。 */
  // @意图#R729(2026-11-04): 返回观察结果（截图或元素清单）；资料目录、模式切换都在这里管
  async function run(botId, action, args = {}) {
    profileDirFor(botId, env); // 先校验 bot_id
    const prev = queues.get(botId) ?? Promise.resolve();
    const job = prev.catch(() => {}).then(async () => {
      if (action === "close" && !bots.has(botId) && !opening.has(botId)) return { kind: "text", text: "浏览器本来就没开" };
      ensureInstalled(env, prog);
      const e = await get(botId);
      const g = e.gen;
      try {
        const r = await act(e, action, { ...args, __bot: botId });
        if (bots.get(botId) === e) arm(botId, e);
        return r;
      } catch (err) {
        const now = bots.get(botId);
        if (action !== "close" && (now?.gen ?? -1) !== g) throw new Error(now || opening.has(botId) ? RETRY_TEXT : CLOSED_BY_USER);
        throw err;
      }
    });
    queues.set(botId, job);
    try { return await job; } finally { if (queues.get(botId) === job) queues.delete(botId); }
  }

  return {
    run,
    openHeaded,
    /** 测试 / 排查用：这个 bot 现在的模式（null = 没开） */
    mode(botId) { const e = bots.get(botId); return e ? (e.headed ? "headed" : "headless") : null; },
    /** 测试用：这个 bot 的 BrowserContext（模拟用户关窗口） */
    _contextOf(botId) { return bots.get(botId)?.ctx ?? null; },
    /** 运行器退出时关掉所有浏览器 */
    async closeAll() { await Promise.all([...bots.entries()].map(([b, e]) => closeEntry(b, e))); },
  };
}
