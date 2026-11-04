#!/usr/bin/env node
// @意图#R636(2026-10-27): 你电脑上的运行器（第一轮最小可用，king 定甲）：零第三方依赖，只用 Node 22+ 自带的 WebSocket、fetch、进程和文件 API。
// 用法：
//   npx -y agent-hub-runner@latest pair <配对码>@<服务器地址>     （R666：抽屉里就这一条；配完直接连上）
//   node agent-hub/runner/runner.mjs pair <配对码> [--no-start] [--server http://127.0.0.1:3220]
//   node agent-hub/runner/runner.mjs start | stop | status | autostart on|off|status | uninstall
// @意图#R666(2026-10-29): 更傻瓜（king 同意 R666）：抽屉只给一条 npx 命令、配对码后面带服务器（码@域名）、pair 默认配完直接 start（--no-start 只配对）；
//   Mac 上配对后问要不要开机自启（launchd，见 autostart.mjs）；报错一律大白话（Node 版本、连不上的各种原因、配对码不对/用过/过期、已有电脑、权限不够、配置坏了）；
//   同一份配置只能跑一个（配置旁边 <配置>.lock 记进程号）；被服务器 4409 顶掉不再重连；4401/4403/顶掉都正常退出（0）并关掉自启；
//   hello 报自己的版本和是不是开机自启，网页据此提示「有新版本」。
// @意图#R664(2026-10-29): 运行器做成客户电脑 npm 安装的小工具（包名、命令名都是 agent-hub-runner，入口 bin/agent-hub-runner.mjs）：
//   npm i -g agent-hub-runner → agent-hub-runner pair <配对码> --start --server <地址>；以后 agent-hub-runner start。仓库里 node 直接跑照旧。
// @意图#R663(2026-10-29): pair 加 --start（二甲）：配对成功后直接接着 start 连上，网页上只给一条命令；不带 --start 的老用法不变
// @意图#R640(2026-10-27): 一台电脑一个运行器，但每个 bot 有自己的授权目录（bot→目录 对照表 bot_dirs），互相碰不到；king 定乙：没有默认目录，
// 每个 bot 都要在它的私聊里「我的电脑」（R663 起是输入框下面那一行，原来是右栏）点「选择目录」，运行器在本机弹窗选。服务器只报 bot_id，定不了路径。pair 不再收 --dir。
// @意图#R639(2026-10-27): 配对不再选目录（king 定乙，替换 R637 配对时弹窗）；start 连上后在网页「我的电脑」点「选择目录」，
// 服务器经这条 WebSocket 叫运行器在 Mac 上弹系统选文件夹窗口，选完马上生效并写回配置文件。
// 配对后长期令牌和授权目录存在 ~/.agent-runner/config.json（权限 600）；目录只能由你在本机窗口里选，服务器只能叫你弹窗、定不了目录。
// （R639 时目录是一台电脑一个、配对时还能 --dir；R640 起换成每个 bot 一个，老配置里的单一 dir 读到直接忽略。）
// start 在终端前台运行，主动用 WebSocket 连服务器；按 Ctrl-C 立刻断开。没有沙箱。（R666 起有开机自启、npx 用法。）
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { execFile, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runOp } from "./ops.mjs";
import { buildChangeRecord, changesDirFor, CHANGE_ID_RE, createChangeStore } from "./changes.mjs";
import { browserStatus, createBrowserManager, installBrowser } from "./browser.mjs";
import { autostartOff, autostartOffWindows, autostartOn, autostartOnWindows, autostartStatus, autostartStatusWindows, logFileFor, ONLY_MAC, otherAutostarts, runnerHome, truncateLogIfBig } from "./autostart.mjs";

export const PROTOCOL_VERSION = 1;
/** npm 包名，也是装好后的命令名 */
export const PKG_BIN = "agent-hub-runner";
/** R666：抽屉里给的、npx 运行时提示里写的命令前缀（@latest：每次都用最新版，也不会被电脑上旧的全局安装盖掉） */
export const NPX_CMD = `npx -y ${PKG_BIN}@latest`;
/** R666：自己的版本号（读同目录的 package.json；开机自启的副本也带着它），hello 时报给服务器 */
export const RUNNER_VERSION = (() => { try { return String(JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version); } catch { return "0.0.0"; } })();
/** R666：配对请求、连接超时（秒） */
export const PAIR_TIMEOUT_MS = 15_000;
export const HEARTBEAT_MS = 10_000;
export const DEFAULT_SERVER = "http://127.0.0.1:3220";
/** 服务器用这两个关闭码表示令牌不对 / 已在网页上断开：不再重连。 */
export const CLOSE_BAD_TOKEN = 4401;
export const CLOSE_REVOKED = 4403;
/** R666：同一台电脑又连上来一个（同一份配置开了两个运行器），服务器把旧的这条用 4409 断开：不再重连 */
export const CLOSE_REPLACED = 4409;

// @意图#R666(2026-10-29): 默认目录可用 AGENT_RUNNER_HOME 换（测试、开机自启的副本用）；不设时和原来一样是 ~/.agent-runner/config.json
export const configPath = () => process.env.AGENT_RUNNER_CONFIG || path.join(runnerHome(), "config.json");

const stamp = () => new Date().toLocaleTimeString("zh-CN", { hour12: false });
const say = (s) => console.log(`[${stamp()}] ${s}`);

// @意图#R636(2026-10-27): 令牌文件权限 600、目录 700
export function saveConfig(cfg, file = configPath()) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}
// @意图#R666(2026-10-29): 提示改成现在网页上的位置（输入框下面「我的电脑」那一行），不再说「连接电脑」；配置文件坏了说清楚怎么办
export function loadConfig(file = configPath()) {
  if (!existsSync(file)) throw new Error(`还没配对：没有 ${file}。先在网页上 bot 的私聊里点输入框下面「我的电脑」那一行，复制里面的命令运行。`);
  const text = readFileSync(file, "utf8");
  try { return JSON.parse(text); }
  catch { throw new Error(`配置文件坏了：${file}。删掉它（rm "${file}"），再回网页拿新配对码重新配对。`); }
}

// @意图#R666(2026-10-29): pair 默认配完直接 start：--start 照样认（老命令），--no-start 只配对；--autostart / --no-autostart 跳过「开机自动连上？」的提问；
// uninstall --purge 连配置一起删；--version / -v 打版本
// @意图#R663(2026-10-29): 认 --start（只对 pair 有意义，不带值）
export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const out = { cmd: cmd === "--version" || cmd === "-v" ? "version" : cmd === "--help" || cmd === "-h" ? "help" : cmd, positional: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--dir") out.dir = rest[++i];
    else if (a === "--server") out.server = rest[++i];
    else if (a === "--name") out.name = rest[++i];
    else if (a === "--start") out.start = true;
    else if (a === "--no-start") out.start = false;
    else if (a === "--autostart") out.autostart = true;
    else if (a === "--no-autostart") out.autostart = false;
    else if (a === "--purge") out.purge = true;
    else if (a.startsWith("--")) throw new Error(`不认识的参数 ${a}`);
    else out.positional.push(a);
  }
  return out;
}

/** R666：Node 太低时的大白话（bin 入口在加载别的代码之前也用同样的话） */
export const nodeTooOld = (v) => `需要 Node 22 或更新，你这台电脑上是 ${v}。\n（上面如果有几行英文 npm warn EBADENGINE，说的就是这个，不用管它。）\n去 https://nodejs.org 下载 LTS 版装上（Mac 选 .pkg 安装包），装好后关掉终端重新打开，再运行同一条命令。`;
// @意图#R666(2026-10-29): 版本太低的提示改成大白话（怎么装、英文警告不用管）
function checkNode() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22 || typeof WebSocket === "undefined") throw new Error(nodeTooOld(process.versions.node));
}

export const PICK_PROMPT = "选择要授权给 bot 的文件夹";
export const PICK_SCRIPT = `POSIX path of (choose folder with prompt "${PICK_PROMPT}")`;
/** Windows 上的弹窗脚本：系统自带的 .NET 文件夹选择框，不需要任何额外安装。 */
export const PICK_SCRIPT_WIN = [
  "[Console]::OutputEncoding=[Text.Encoding]::UTF8",
  "Add-Type -AssemblyName System.Windows.Forms",
  "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
  `$d.Description = '${PICK_PROMPT}'`,
  "$d.ShowNewFolderButton = $true",
  "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }",
].join("\n");
/** R640：这个 bot 在对照表里没有目录时，调用一律回这句。 */
// @意图#R666(2026-10-29): 「右栏」是 R663 以前的位置，改成输入框下面「我的电脑」那一行（和服务器 devices.ts 的 NO_DIR 一字不差）
export const NO_DIR = "还没给这个 bot 选目录，请在这个 bot 的私聊里点输入框下面「我的电脑」那一行，再点「选择目录」";
export const PICK_ONLY_MAC = "只支持 Mac 和 Windows：选目录的窗口只在 Mac / Windows 上弹";
/** R640：pair 带了 --dir 时的提示（不报错，照常配对，目录不用）。 */
export const PAIR_DIR_IGNORED = "目录请连上后在每个 bot 的私聊里选（--dir 已不用，这次没用它）";

/** 配置里的 bot→目录 对照表。只认 bot_dirs 里值是非空字符串的条目；老格式的单一 dir 直接忽略（所有 bot 都没有目录）。 */
// @意图#R640(2026-10-27): king 定乙：没有默认目录；老配置的 dir 不迁成任何 bot 的目录
export function botDirsOf(cfg) {
  const out = {};
  const m = cfg && typeof cfg.bot_dirs === "object" && cfg.bot_dirs !== null && !Array.isArray(cfg.bot_dirs) ? cfg.bot_dirs : {};
  for (const [bot, dir] of Object.entries(m)) if (bot && typeof dir === "string" && dir) out[bot] = dir;
  return out;
}

/**
 * Mac 上弹系统「选文件夹」窗口。选了返回 POSIX 路径；点取消返回 null；signal 中止时关掉窗口进程并抛 AbortError；
 * 弹不出来（比如没有图形界面）抛错。
 */
// @意图#R640(2026-10-27): 弹不出来时不再提 --dir（pair 不收 --dir 了）
// @意图#R639(2026-10-27): 改成网页点「选择目录」时调用；服务器超时发 abort 要能关掉弹窗进程
// @意图#R637(2026-10-27): 不写 --dir 时用 osascript 弹系统选文件夹窗口（king 定）；取消和弹不出来分开报
export function pickDirMac({ signal } = {}) {
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", PICK_SCRIPT], { encoding: "utf8", signal }, (err, stdout, stderr) => {
      if (!err) {
        const p = String(stdout).trim();
        return p ? resolve(p) : resolve(null);
      }
      if (signal?.aborted || err.name === "AbortError") return reject(Object.assign(new Error("已中止"), { name: "AbortError" }));
      if (/-128|User canceled|用户已取消/.test(String(stderr))) return resolve(null);
      const why = String(stderr).trim() || err.message;
      reject(new Error(`弹不出选文件夹的窗口（${why}）`));
    });
  });
}

/** 检查授权目录：存在、换成真实路径、是目录、不是磁盘根目录。返回真实路径。 */
// @意图#R640(2026-10-27): 每个 bot 选的目录都走这套检查

/**
 * Windows 上弹系统「选文件夹」窗口（.NET FolderBrowserDialog，系统自带，不用装任何东西）。
 * 选了返回路径；点取消返回 null；signal 中止时 taskkill 关掉窗口并抛 AbortError；弹不出来（没有桌面会话）抛错。
 */
// @意图#R716(2026-11-02): Windows 客户是小白，不能要求装 Git Bash，也不能靠手填路径；弹窗用系统自带的 .NET 窗口
export function pickDirWindows({ signal, spawn: spawnFn = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const b64 = Buffer.from(PICK_SCRIPT_WIN + "\n", "utf16le").toString("base64");
    // 带 -STA：FolderBrowserDialog 要求单线程公寓；不带 -NonInteractive：要的就是交互窗口
    const child = spawnFn("powershell.exe", ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-OutputFormat", "Text", "-EncodedCommand", b64], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    let err = "";
    let settled = false;
    const settle = (fn, v) => { if (!settled) { settled = true; signal?.removeEventListener("abort", onAbort); fn(v); } };
    const killIt = () => {
      if (child.pid) { try { spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); } catch { /* 已退出 */ } }
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    };
    const onAbort = () => { killIt(); settle(reject, Object.assign(new Error("已中止"), { name: "AbortError" })); };
    if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener("abort", onAbort, { once: true }); }
    child.stdout?.on("data", (d) => { out += d.toString("utf8"); });
    child.stderr?.on("data", (d) => { err += d.toString("utf8"); });
    child.on("error", (e) => settle(reject, new Error(`弹不出选文件夹的窗口（${e?.message ?? e}）`)));
    child.on("close", () => {
      const picked = out.trim();
      if (picked) return settle(resolve, picked);
      const why = err.trim().split("\n")[0].trim();
      if (why) return settle(reject, new Error(`弹不出选文件夹的窗口（${why}）`));
      settle(resolve, null); // 点了取消：对话框没点确定，没有输出
    });
  });
}

// @意图#R639(2026-10-27): 配对时的 --dir 和网页上选的目录走同一套检查
export async function checkDir(dir) {
  const real = await fs.realpath(path.resolve(dir)).catch(() => { throw new Error(`授权目录不存在：${dir}`); });
  if (!statSync(real).isDirectory()) throw new Error(`授权目录不是目录：${dir}`);
  if (real === path.parse(real).root) throw new Error("不能把整个磁盘根目录授权出去");
  return real;
}

/** 配对：用一次性配对码换长期令牌，存进本地配置。不选目录（连上后在每个 bot 的私聊里选）；带了 dir 不报错、不用，返回 dirIgnored。 */
// @意图#R640(2026-10-27): 去掉 --dir：带了只提示「目录请连上后在每个 bot 的私聊里选」，照常配对；配置里 bot_dirs 是空表、不再有 dir
// @意图#R639(2026-10-27已废弃): 配对不弹窗、不要求目录（king 定乙）；--dir 还能用，给了就照旧检查；没给 config.dir 为空（R640 去掉 --dir）
// @意图#R637(2026-10-27已废弃): Mac 上没写 --dir 就弹窗选目录、取消不请求服务器（R639 改成连上后在网页上选）
// @意图#R636(2026-10-27): 配对码一次性、5 分钟有效（服务器判断）；授权目录先换成真实路径再存
// @意图#R666(2026-10-29): 配对码可以写成「码@服务器」（code 里带 @ 时拆开，见 parsePairTarget；显式给了 server 就用 server）；15 秒超时；
// 连不上、服务器回错都翻成大白话（explainNetError / explainPairFailure）；缺码的提示不再写 runner.mjs
export async function pair({ code, dir, server, name = os.hostname(), timeoutMs = PAIR_TIMEOUT_MS }, file = configPath()) {
  checkNode();
  const t = parsePairTarget(code, server);
  if (!t.code) throw new Error(`缺配对码：${progName()} pair <配对码>@<服务器地址>（请从网页上原样复制整条命令）`);
  let r;
  try {
    r = await fetch(`${t.server}/devices/pair`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: t.code, name, os: `${process.platform} ${os.release()}` }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) { throw new Error(explainNetError(e, t.server, timeoutMs)); }
  const text = await r.text().catch(() => "");
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  if (r.status !== 201 || !body || typeof body.token !== "string") throw new Error(explainPairFailure(r.status, body));
  saveConfig({ server: t.server, device_id: body.device_id, token: body.token, name, bot_dirs: {} }, file);
  return { deviceId: body.device_id, file, server: t.server, dirIgnored: dir !== undefined && dir !== null && dir !== "" };
}

const isLoopback = (h) => h === "localhost" || /^127\./.test(h) || h === "[::1]" || h === "::1";
/**
 * 「码@服务器」拆成 { code, server }（R666）：@ 后面没写 http:// / https:// 时默认 https，localhost、127.x、[::1] 用 http；可以带端口、路径；
 * 去掉末尾的 /。显式给了 server（--server）就用它；没 @ 也没 --server 用 DEFAULT_SERVER（老行为）。地址看不懂、带 ? # 或账号密码就报错。
 */
// @意图#R666(2026-10-29): 配对码里带服务器信息（king 定一甲：码@域名），命令里不用再写 --server；老写法 pair 码 --server 地址照样能用
export function parsePairTarget(raw, server) {
  const s = String(raw ?? "").trim();
  const at = s.indexOf("@");
  const code = (at < 0 ? s : s.slice(0, at)).trim();
  const where = at < 0 ? "" : s.slice(at + 1).trim();
  if (server) return { code, server: String(server).trim().replace(/\/+$/, "") };
  if (!where) return { code, server: DEFAULT_SERVER };
  const explicit = /^https?:\/\//i.test(where);
  let u;
  try { u = new URL(explicit ? where : `https://${where}`); }
  catch { throw new Error(`配对码后面的服务器地址看不懂：${where}。请从网页上原样复制整条命令。`); }
  if (u.search || u.hash || u.username || u.password) throw new Error(`服务器地址不能带 ? # 或账号密码：${where}。请从网页上原样复制整条命令。`);
  if (!explicit && isLoopback(u.hostname)) u.protocol = "http:";
  return { code, server: `${u.origin}${u.pathname}`.replace(/\/+$/, "") };
}

const hostOf = (server) => { try { return new URL(server).host; } catch { return server; } };
/** fetch 失败（连不上）翻成大白话：找不到、没开、证书、超时、被断开、其他 */
// @意图#R666(2026-10-29): 原来只打一句英文 fetch failed；按 cause.code 分开说（king 定五）
export function explainNetError(e, server, timeoutMs = PAIR_TIMEOUT_MS) {
  const code = String(e?.cause?.code ?? e?.cause?.cause?.code ?? e?.code ?? "");
  const host = hostOf(server);
  if (e?.name === "TimeoutError" || e?.name === "AbortError" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "ETIMEDOUT") {
    return `连服务器超时（${Math.round(timeoutMs / 1000)} 秒没回应）：${host}。检查这台电脑能不能上网，或者稍后再试。`;
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return `找不到服务器 ${host}：命令里 @ 后面的地址可能写错了，或者这台电脑没联网。`;
  if (code === "ECONNREFUSED") return `连不上服务器 ${server}：服务器没开，或者地址、端口不对。`;
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS|SSL/.test(code)) return `服务器 ${host} 的 https 证书有问题（${code}）：可能证书过期了，或者网络在拦截。请告诉服务器的管理员。`;
  if (code === "ECONNRESET" || code === "EPIPE" || code === "UND_ERR_SOCKET") return `和服务器 ${host} 的连接被断开了：稍后再试；一直这样请检查代理或网络。`;
  return `连不上服务器 ${server}（${code || e?.message || "未知原因"}）：检查网络和命令里的地址。`;
}

/** R666：服务器回的错误码（/devices/pair 返回的 code）对应的大白话 */
export const PAIR_ERR = {
  bad_code: "配对码不对：请从网页上原样复制整条命令再运行（码只能用一次，5 分钟有效）。",
  used: "这个配对码已经用过了：回网页点「换一个码」，再复制新命令运行。",
  replaced: "这个配对码已经作废了（网页上换过新码）：请复制网页上最新的那条命令运行。",
  expired: "配对码过期了（5 分钟有效）：回网页点「换一个码」，再复制新命令运行。",
  device_exists: "这个账号已经连着一台电脑了：先在网页「我的电脑」抽屉最下面「连着的电脑」里点「断开」，再换一个码重新配对。",
  bad_input: "命令不完整：请从网页上原样复制整条命令再运行。",
};
const NOT_HUB = (status) => `这个地址不是 agent-hub 服务器（回了 ${status}）：检查命令里 @ 后面的地址，请从网页上原样复制整条命令。`;
/** 配对请求回的不是 201：先看服务器给的 code，老服务器没 code 就按状态码猜；回的不是 JSON 多半不是 agent-hub */
// @意图#R666(2026-10-29): 400/410/409/404/405/非 JSON/5xx 各给一句（king 定五）
export function explainPairFailure(status, body) {
  if (body && typeof body === "object" && PAIR_ERR[body.code]) return `配对失败：${PAIR_ERR[body.code]}`;
  if (status === 404 || status === 405) return `配对失败：${NOT_HUB(status)}`;
  if (status >= 500) return `配对失败：服务器出错了（${status}），稍后再试。`;
  if (!body || typeof body !== "object") return `配对失败：${NOT_HUB(status)}`;
  if (status === 410) return `配对失败：${PAIR_ERR.expired}`;
  if (status === 409) return `配对失败：${PAIR_ERR.device_exists}`;
  if (status === 400) return `配对失败：${PAIR_ERR.bad_code}`;
  return `配对失败（${status}）：${body.error ?? "未知原因"}`;
}

/** 整个命令出错时打给人看的话：权限不够（多半用 sudo 跑过）单独说怎么修，别的原样 */
// @意图#R666(2026-10-29): EACCES / EPERM 提示别用 sudo + chown（king 定五）
export function explainError(e) {
  const code = e?.code;
  if (code === "EACCES" || code === "EPERM") {
    const p = e.path ? String(e.path) : runnerHome();
    const dir = p.startsWith(runnerHome()) ? runnerHome() : path.dirname(p);
    return `权限不够，写不了 ${p}：别用 sudo 运行这个命令。如果以前用 sudo 跑过，先运行 sudo chown -R "$(whoami)" "${dir}"，再重新运行。`;
  }
  return e?.message ?? String(e);
}

const wsUrlOf = (server) => `${server.replace(/^http/, "ws")}/devices/ws`;

/**
 * 一条连接上的工作：执行工具调用、网页叫弹窗选目录。每个 bot 一个授权目录（对照表），选完新目录，这个 bot 之后的调用只认新目录；已经在跑的不打断。
 * 返回 { onMessage(msg, send), killAll(), botDirs }，startRunner 用它，测试也直接用它（不用起 WebSocket）。
 */
// @意图#R640(2026-10-27): 目录按 bot 分：call 按 bot_id 查对照表，没有就拒绝 NO_DIR；pick_dir 带 bot_id，选完检查后记进对照表、写回配置（600），
// 回 dir_result {id, ok, bot_id, dir}；老配置的单一 dir 忽略
// @意图#R639(2026-10-27已废弃): 目录不再是连接时固定的常量；没目录时 call 一律拒绝；pick_dir 选完检查、写回配置（600）、回 dir_result（R640 改成按 bot 分）
// @意图#R690(2026-11-01): write / edit 带 change_id（服务器记灰字时生成的 auto_id）就在写改成功后存一份改动记录（存失败只记日志）；
// 新消息 change_get {id, change_id} → change_result {id, ok:true, found, record}，不看这个 bot 有没有目录（换了目录也能看旧记录）
// @意图#R729(2026-11-04): 新消息 browser {id, bot_id, action, args} → result（截图或元素清单）、browser_open {id, bot_id} → result（网页点「打开 bot 的浏览器」）；
// 浏览器不看这个 bot 有没有选目录（资料目录在 ~/.agent-runner/browser-profiles/<bot_id>/，和授权目录无关）；断线不关浏览器（重连后接着用）
export function createSession(cfg, { log = say, platform = process.platform, pickDir = platform === "win32" ? pickDirWindows : pickDirMac, file = configPath(), changes, browser } = {}) {
  let dirs = botDirsOf(cfg); // bot_id → 授权目录
  let browsers = browser; // R729：每个 bot 一只浏览器，用到时才建
  const browserMgr = () => (browsers ??= createBrowserManager({ log }));
  const jobs = new Map(); // 调用 id → AbortController
  const picks = new Map(); // 弹窗 id → AbortController
  let store = changes; // 改动记录（R690），用到时才建
  const changeStore = () => (store ??= createChangeStore(changesDirFor(file), { log }));
  const recorder = (args) => {
    const id = typeof args?.change_id === "string" ? args.change_id : "";
    if (!CHANGE_ID_RE.test(id)) return undefined;
    return async (info) => {
      try { await changeStore().save(id, buildChangeRecord({ id, ...info })); } catch (e) { log(`改动记录没存上（不影响这次写改）：${e?.message ?? e}`); }
    };
  };

  async function handleChangeGet(send, msg) {
    const record = await changeStore().get(msg.change_id).catch(() => null);
    send({ type: "change_result", id: msg.id, ok: true, found: !!record, ...(record ? { record } : {}) });
  }

  async function handleCall(send, msg) {
    const { id, op, args } = msg;
    const bot = typeof msg.bot_id === "string" ? msg.bot_id : "";
    const dir = bot ? dirs[bot] : undefined; // 这次调用用开始时这个 bot 的目录；中途换目录不影响它
    if (!dir) { send({ type: "result", id, ok: false, error: NO_DIR }); return; }
    const ac = new AbortController();
    jobs.set(id, ac);
    log(`[${bot}] ${op === "bash" ? `bash：${args?.command}` : `${op}：${args?.path}`}`);
    try {
      const onChange = op === "write" || op === "edit" ? recorder(args) : undefined;
      const res = await runOp(op, args, dir, { signal: ac.signal, onChange, onData: (d) => send({ type: "output", id, data: Buffer.from(d).toString("base64") }) });
      if (ac.signal.aborted) send({ type: "result", id, ok: false, error: "已中止" });
      else send({ type: "result", id, ok: true, ...res });
    } catch (e) {
      send({ type: "result", id, ok: false, error: e?.message ?? String(e) });
    } finally {
      jobs.delete(id);
    }
  }

  // @意图#R729(2026-11-04): bot 用浏览器：全部自动允许（不弹卡）；打字只记字数（可能是密码）
  async function handleBrowser(send, msg) {
    const { id } = msg;
    const bot = typeof msg.bot_id === "string" ? msg.bot_id : "";
    const action = typeof msg.action === "string" ? msg.action : "";
    const args = msg.args && typeof msg.args === "object" ? msg.args : {};
    if (!bot) { send({ type: "result", id, ok: false, error: "缺 bot_id" }); return; }
    log(`[${bot}] 浏览器：${action}${action === "open" ? ` ${args.url ?? ""}` : action === "type" ? `（${String(args.text ?? "").length} 个字）` : ""}`);
    try {
      const res = await browserMgr().run(bot, action, args);
      send({ type: "result", id, ok: true, ...res });
    } catch (e) {
      send({ type: "result", id, ok: false, error: e?.message ?? String(e) });
    }
  }
  // @意图#R729(2026-11-04): 网页点「打开 bot 的浏览器」：在这台电脑上弹出有窗口的浏览器（后台的换成有窗口的，恢复打开的网址）
  async function handleBrowserOpen(send, msg) {
    const { id } = msg;
    const bot = typeof msg.bot_id === "string" ? msg.bot_id : "";
    if (!bot) { send({ type: "result", id, ok: false, error: "缺 bot_id" }); return; }
    try {
      const r = await browserMgr().openHeaded(bot);
      send({ type: "result", id, ok: true, bot_id: bot, already: !!r.already, urls: r.urls ?? [] });
    } catch (e) {
      send({ type: "result", id, ok: false, bot_id: bot, error: e?.message ?? String(e) });
    }
  }

  async function handlePick(send, msg) {
    const { id } = msg;
    const bot = typeof msg.bot_id === "string" ? msg.bot_id : "";
    if (!bot) { send({ type: "dir_result", id, ok: false, error: "缺 bot_id" }); return; }
    if (platform !== "darwin" && platform !== "win32") { send({ type: "dir_result", id, ok: false, bot_id: bot, error: PICK_ONLY_MAC }); return; }
    const ac = new AbortController();
    picks.set(id, ac);
    log(`网页上给 bot ${bot} 点了选择目录：请在弹出的窗口里选文件夹`);
    try {
      const picked = await pickDir({ signal: ac.signal });
      if (ac.signal.aborted) return; // 服务器那边已经按超时处理了
      if (!picked) { log("没换目录（点了取消）"); send({ type: "dir_result", id, ok: false, bot_id: bot, cancelled: true }); return; }
      const real = await checkDir(picked);
      dirs = { ...dirs, [bot]: real };
      cfg.bot_dirs = { ...dirs };
      delete cfg.dir; // 老格式的单一 dir 不再写回
      saveConfig(cfg, file);
      log(`bot ${bot} 的授权目录换成 ${real}`);
      send({ type: "dir_result", id, ok: true, bot_id: bot, dir: real });
    } catch (e) {
      if (ac.signal.aborted) { log("选目录超时，窗口已关掉"); return; }
      send({ type: "dir_result", id, ok: false, bot_id: bot, error: e?.message ?? String(e) });
    } finally {
      picks.delete(id);
    }
  }

  return {
    get botDirs() { return { ...dirs }; },
    /** R690：清掉 30 天前的改动记录（startRunner 启动时调一次） */
    cleanChanges() { return changeStore().clean(true).catch(() => 0); },
    onMessage(msg, send) {
      if (msg.type === "call") return handleCall(send, msg);
      if (msg.type === "pick_dir") return handlePick(send, msg);
      if (msg.type === "change_get") return handleChangeGet(send, msg);
      if (msg.type === "browser") return handleBrowser(send, msg); // R729
      if (msg.type === "browser_open") return handleBrowserOpen(send, msg); // R729
      if (msg.type === "abort") { jobs.get(msg.id)?.abort(); picks.get(msg.id)?.abort(); }
      return undefined;
    },
    killAll() {
      for (const ac of jobs.values()) ac.abort();
      for (const ac of picks.values()) ac.abort();
      jobs.clear();
      picks.clear();
    },
    /** R729：运行器退出时关掉所有 bot 的浏览器 */
    closeBrowsers() { return browsers ? browsers.closeAll() : Promise.resolve(); },
  };
}

/**
 * 连服务器并执行转发来的工具调用。断线会自动重连（不重放旧调用）；令牌不对或网页上断开了就停。
 * 返回 { stop, done }：stop() 立刻断开并杀掉正在跑的命令。
 */
// @意图#R666(2026-10-29): hello 多报 runner_version（网页提示有新版本）和 autostart（是不是开机自启起的，网页据此给升级命令）；
// 服务器用 4409 顶掉这条（同一份配置又开了一个）：不再重连、结束（"replaced"）；连不上时只在第一次和之后每 30 次打一行，开机自启没网时日志不刷屏；
// 连上那句不再说「右栏」，开机自启时不说「按 Ctrl-C」
// @意图#R729(2026-11-04): hello 和心跳多报浏览器装没装（browser: {installed, version}），网页抽屉据此显示「未安装」和安装命令；装好后不用重启，下一次心跳就更新；
// 停掉时关掉所有 bot 的浏览器
// @意图#R640(2026-10-27): hello 报 bot→目录 对照表（bot_dirs），不再报单一 dir
// @意图#R639(2026-10-27): 没目录也能连上；目录由 createSession 管（网页上选完马上生效），重连时 hello 带当前目录
// @意图#R636(2026-10-27): 前台运行、心跳、执行工具调用；断线时杀掉正在跑的命令，重连后不重放
export function startRunner(cfg, { log = say, retryMs = 2000, platform = process.platform, pickDir = platform === "win32" ? pickDirWindows : pickDirMac, file = configPath(), background = process.env.AGENT_RUNNER_LAUNCHD === "1" } = {}) {
  checkNode();
  let fails = 0;
  const session = createSession(cfg, { log, pickDir, platform, file });
  void session.cleanChanges(); // R690：启动时清一次 30 天前的改动记录
  let ws = null;
  let stopped = false;
  let beat = null;
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  const finish = (why) => { if (!stopped) { stopped = true; } resolveDone(why); };
  const send = (sock, msg) => { if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(msg)); };
  const browserInfo = () => { try { const b = browserStatus(); return { installed: b.installed, version: b.version }; } catch { return { installed: false, version: null }; } };

  function connect() {
    if (stopped) return;
    const sock = new WebSocket(wsUrlOf(cfg.server));
    ws = sock;
    sock.addEventListener("open", () => {
      send(sock, { type: "hello", version: PROTOCOL_VERSION, device_id: cfg.device_id, token: cfg.token, bot_dirs: session.botDirs,
        name: cfg.name ?? os.hostname(), os: `${process.platform} ${os.release()}`, runner_version: RUNNER_VERSION, autostart: background, browser: browserInfo() });
      beat = setInterval(() => send(sock, { type: "ping", browser: browserInfo() }), HEARTBEAT_MS);
    });
    sock.addEventListener("message", (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8")); } catch { return; }
      if (msg.type === "ready") {
        fails = 0;
        const n = Object.keys(session.botDirs).length;
        const tail = background ? "（开机自启，在后台运行）" : "按 Ctrl-C 断开。";
        log(n ? `已连上服务器 ${cfg.server}，${n} 个 bot 选了目录。${tail}`
          : `已连上服务器 ${cfg.server}，还没有 bot 选目录：请在网页上每个 bot 的私聊里点输入框下面「我的电脑」那一行，再点「选择目录」。${tail}`);
      } else if (msg.type === "revoked") { session.killAll(); log("网页上已断开这台电脑，令牌已作废。要再连，请在网页上重新拿配对码配对。"); }
      else void session.onMessage(msg, (m) => send(sock, m));
    });
    sock.addEventListener("close", (ev) => {
      clearInterval(beat);
      session.killAll(); // 断线：正在跑的命令杀掉、弹窗关掉，服务器那边按「设备离线」返回，重连后不重放
      if (ws === sock) ws = null;
      if (stopped) return;
      if (ev.code === CLOSE_BAD_TOKEN) { log("服务器不认这个令牌（可能已经在网页上断开过）。请重新配对。"); finish("bad_token"); return; }
      if (ev.code === CLOSE_REVOKED) { log("这台电脑已在网页上断开。请重新配对。"); finish("revoked"); return; }
      if (ev.code === CLOSE_REPLACED) { log("同一份配置在别处又开了一个运行器，服务器把这个顶掉了：这个先退出（不再重连）。"); finish("replaced"); return; }
      fails += 1;
      if (fails === 1 || fails % 30 === 0) log(`和服务器的连接断了，${retryMs / 1000} 秒后重连${fails > 1 ? `（已经连不上 ${fails} 次，会一直重试）` : ""}`);
      setTimeout(connect, retryMs);
    });
    sock.addEventListener("error", () => { /* close 里处理 */ });
  }
  connect();
  const stop = () => {
    if (stopped) return;
    stopped = true;
    session.killAll();
    void session.closeBrowsers(); // R729
    clearInterval(beat);
    try { ws?.close(1000, "runner stopped"); } catch { /* ignore */ }
    resolveDone("stopped");
  };
  return { stop, done };
}

/** R666：同一份配置只能跑一个：配置旁边的 <配置>.lock 记着进程号 */
export const lockPath = (file = configPath()) => `${file}.lock`;
export function readLock(file = configPath()) {
  try { const j = JSON.parse(readFileSync(lockPath(file), "utf8")); return Number.isInteger(j?.pid) ? j : null; } catch { return null; }
}
export const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; } };
/**
 * 拿锁：别的活着的进程拿着就返回 { ok: false, pid, launchd }；否则写上自己（600）返回 { ok: true, release }。
 * 进程死了留下的旧锁直接覆盖。
 */
/** R732：a 比 b 新（只比 x.y.z；带预发布后缀的算旧一点；b 不是版本号 = 很旧） */
export function newerVersion(a, b) {
  const re = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;
  const pa = re.exec(String(a ?? "")); const pb = re.exec(String(b ?? ""));
  if (!pa) return false;
  if (!pb) return true;
  for (let i = 1; i <= 3; i++) { const d = Number(pa[i]) - Number(pb[i]); if (d) return d > 0; }
  return !String(a).includes("-") && String(b).includes("-");
}
// @意图#R732(2026-11-04): 锁里记版本号；拿不到锁时告诉调用方对方是不是旧版本（older：锁里没版本号或比我旧），旧的由 runStart 顶掉
// @意图#R666(2026-10-29): 防互踢（king 定必须做）：开机自启的在后台跑着，再在终端里 start 就提示「已经在后台连着」退出，不再两个互相顶
export function takeLock(file = configPath(), { pid = process.pid, launchd = process.env.AGENT_RUNNER_LAUNCHD === "1", version = RUNNER_VERSION } = {}) {
  const cur = readLock(file);
  if (cur && cur.pid !== pid && pidAlive(cur.pid)) return { ok: false, pid: cur.pid, launchd: !!cur.launchd, version: cur.version ?? null, older: newerVersion(version, cur.version) };
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(lockPath(file), `${JSON.stringify({ pid, launchd, version, started_at: new Date().toISOString() })}\n`, { mode: 0o600 });
  return { ok: true, release: () => { if (readLock(file)?.pid === pid) rmSync(lockPath(file), { force: true }); } };
}

// @意图#R725(2026-11-03): Windows 被断开时也关掉计划任务，不然下次登录又白起一次
/** 被网页断开 / 令牌失效后把这份配置的开机自启关掉（不然每次登录都白起一次）；不是 Mac / Windows、没开都不要紧 */
async function autostartOffQuietly(file, deps) {
  const platform = deps.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "win32") return false;
  try {
    const r = platform === "win32"
      ? await autostartOffWindows({ configFile: file, schtasks: deps.schtasks })
      : await autostartOff({ configFile: file, launchctl: deps.launchctl });
    return r.wasOn;
  } catch { return false; }
}

// @意图#R732(2026-11-04): 拿锁时发现拿着锁的是旧版本（或没记版本的老运行器）就先让它退出再接管，客户升级后不用自己停旧进程；同版本或更新的照旧提示退出
// @意图#R666(2026-10-29): 先拿锁（后台已在跑就提示退出 0）；开机自启时启动前日志超 5MB 清空、配置坏了/没配对也退出 0（不让 launchd 反复拉起）；
// 结束一律退出码 0（Ctrl-C、被网页断开、令牌失效、被顶掉），被断开 / 令牌失效时顺手关掉自启
// @意图#R663(2026-10-29): 前台跑 start，Ctrl-C 断开（pair --start 和 start 共用）
async function runStart(prog = progName(), deps = {}) {
  const file = configPath();
  const background = process.env.AGENT_RUNNER_LAUNCHD === "1";
  if (background && truncateLogIfBig(logFileFor(file))) say("日志超过 5MB，已清空");
  let cfg;
  try { cfg = loadConfig(file); } catch (e) {
    if (background) { console.error(explainError(e)); process.exit(0); }
    throw e;
  }
  let lock = takeLock(file);
  if (!lock.ok && lock.older) {
    // R732：后台是旧版本（升级前起的那个还在内存里）：让它退出，我来接
    const old = lock;
    await stopPid(old.pid);
    lock = takeLock(file);
    if (lock.ok) say(`已顶掉旧版本 ${old.version ?? "（0.2.1 以前）"}（进程 ${old.pid}），现在是 ${RUNNER_VERSION}`);
  }
  if (!lock.ok) {
    console.log(`已经在后台连着，不用再开（进程 ${lock.pid}${lock.launchd ? "，开机自启起的" : ""}）。要停掉它：${prog} stop`);
    process.exit(0);
  }
  const r = startRunner(cfg, { file, background });
  const quit = () => { r.stop(); lock.release(); setTimeout(() => process.exit(0), 100); };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
  const why = await r.done;
  lock.release();
  if (why === "bad_token" || why === "revoked") {
    if (await autostartOffQuietly(file, deps)) say("已关掉开机自启（这台电脑在网页上断开了）。");
  }
  process.exit(0);
}

// @意图#R725(2026-11-03): Windows 也支持开机自启（计划任务，见 autostart.mjs）。Mac 和 Windows 都问；别的系统不开。
/** R666：配完要不要开机自启：flag（--autostart / --no-autostart）优先；不是 Mac / Windows 不开；是终端就问；不是终端（脚本、管道）不问、只提示 */
export function decideAutostart({ flag, platform = process.platform, tty = !!(process.stdin.isTTY && process.stdout.isTTY) }) {
  const supported = platform === "darwin" || platform === "win32";
  if (flag === true) return supported ? "on" : "unsupported";
  if (flag === false) return "off";
  if (!supported) return "off";
  return tty ? "ask" : "hint";
}

/** 终端里问一句 是/否；直接回车 = dflt */
export async function askYesNo(question, dflt = true, { input = process.stdin, output = process.stdout } = {}) {
  const rl = readline.createInterface({ input, output });
  try {
    const a = (await rl.question(question)).trim().toLowerCase();
    if (!a) return dflt;
    return ["y", "yes", "是", "好", "要"].includes(a);
  } finally { rl.close(); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 停掉拿着锁的那个运行器（不是自己）；等它真退出（最多 5 秒）。返回被停的锁信息，没有在跑的返回 null */
async function stopHolder(file) {
  const l = readLock(file);
  if (!l || l.pid === process.pid || !pidAlive(l.pid)) return null;
  await stopPid(l.pid);
  return l;
}
/** R732：发 SIGTERM 让它正常退出（退出码 0，launchd 不会再拉起），等最多 5 秒 */
async function stopPid(pid) {
  try { process.kill(pid, "SIGTERM"); } catch { /* 已经没了 */ }
  for (let i = 0; i < 50 && pidAlive(pid); i++) await sleep(100);
}
/** R732：等新起的后台运行器拿到锁（锁里是 version 且进程活着），最多 ms 毫秒；拿到返回锁信息，超时 null */
export async function waitNewHolder(file, { version = RUNNER_VERSION, ms = 10000, step = 200 } = {}) {
  for (let t = 0; ; t += step) {
    const l = readLock(file);
    if (l && l.pid !== process.pid && l.version === version && pidAlive(l.pid)) return l;
    if (t >= ms) return null;
    await sleep(step);
  }
}

const here = () => path.dirname(fileURLToPath(import.meta.url));
// @意图#R666(2026-10-29): 开启自启：前台有一个在跑就先停掉它（不然后台那个起来就因为锁退出了），再交给 autostart.mjs（复制自己、写 plist、加载）
// @意图#R725(2026-11-03): Windows 走计划任务（autostartOnWindows），Mac 走 launchd。提示里的「这台 Mac」按平台写。
// @意图#R732(2026-11-04): 不管拿着锁的是终端里的还是开机自启起的（包括别的标签起的旧版本），一律先停掉；装好后等新版本真的拿到锁才报「已设开机自启」，没接上就说清楚、给日志位置
async function turnAutostartOn(file, prog, deps = {}) {
  await stopHolder(file);
  const platform = deps.platform ?? process.platform;
  const r = platform === "win32"
    ? await autostartOnWindows({ configFile: file, version: RUNNER_VERSION, srcDir: here(), execPath: deps.execPath, schtasks: deps.schtasks })
    : await autostartOn({ configFile: file, version: RUNNER_VERSION, srcDir: here(), launchctl: deps.launchctl, platform });
  const where = platform === "win32" ? "这台电脑" : "这台 Mac";
  const got = await (deps.waitNewHolder ?? waitNewHolder)(file, { version: RUNNER_VERSION });
  if (!got) {
    console.log(`开机自启已经装好（${RUNNER_VERSION}），但等了 10 秒后台还没连上。可以看日志找原因：${r.log}\n过一会儿可以再运行一次：${prog} autostart on`);
    return r;
  }
  console.log(`已设开机自启：以后登录${where}会自动连上，不用开终端。现在已经在后台连着，可以关掉这个终端窗口了。\n日志：${r.log}\n关掉开机自启：${prog} autostart off`);
  return r;
}

const usage = (prog) => `用法：
  ${prog} pair <配对码>@<服务器地址> [--no-start] [--autostart | --no-autostart]
    （网页上「我的电脑」里复制的就是这一条；配完直接连上，Mac 上会问要不要开机自动连上；--no-start 只配对不连）
    （老写法 ${prog} pair <配对码> --server <地址> 也能用）
  ${prog} start              连上服务器（终端窗口别关；Ctrl-C 断开）
  ${prog} stop               停掉在跑的运行器
  ${prog} status             看配置、各 bot 的目录、在不在跑、开机自启
  ${prog} set-dir <bot_id> <路径>   直接指定这个 bot 的授权目录（和网页上点「选择目录」走同一套检查；弹窗弹不出来时用）
  ${prog} autostart on|off|status   开机自启（Mac 用 launchd，Windows 用计划任务；on 也用来升级到新版本）
  ${prog} uninstall [--purge]       关掉自启、删掉本地副本和日志（--purge 连配置一起删）
  ${prog} browser install    装 bot 专用的浏览器（playwright-core + 一只独立的 Chromium，约 200MB，先官方源、失败换国内镜像）
  ${prog} browser status     看浏览器装没装
  ${prog} --version
目录请连上后在网页上每个 bot 的私聊里点输入框下面「我的电脑」那一行选，Mac / Windows 上会弹窗让你选。`;

// @意图#R729(2026-11-04): 新命令 browser install | status（装 bot 专用浏览器、看装没装）
// @意图#R666(2026-10-29): pair 默认配完直接 start（--no-start 只配对）；配完按 decideAutostart 问 / 提示 / 开启开机自启，开了就不在前台跑；
// 新命令 stop、autostart on|off|status、uninstall、--version；status 多显示在不在跑、版本、开机自启；用法里的命令按运行方式写（npx 时写 npx 写法）
// @意图#R664(2026-10-29): 导出给 bin/agent-hub-runner.mjs 调；用法和「现在运行：… start」里的命令名用 progName（装好的 agent-hub-runner，仓库里 node 写法）
// @意图#R663(2026-10-29): pair --start 配对成功后直接进 start（二甲）；提示里「我的电脑」改成在私聊输入框下面那一行点开（R663 挪了位置）；不带 --start 照旧提示再运行 start（R666 起默认就 start，--no-start 才提示）
// @意图#R640(2026-10-27): pair 带 --dir 只提示不报错；status 列出每个 bot 的目录；用法文字去掉 --dir
export async function main(argv, prog = progName(), deps = {}) {
  checkNode();
  const a = parseArgs(argv);
  const platform = deps.platform ?? process.platform;
  if (a.cmd === "pair") {
    const r = await pair({ code: a.positional[0], dir: a.dir, server: a.server, name: a.name ?? os.hostname() });
    if (r.dirIgnored) console.log(PAIR_DIR_IGNORED);
    const where = "目录：连上后在网页上每个 bot 的私聊里，点输入框下面「我的电脑」那一行选。";
    console.log(`配对成功（服务器 ${r.server}）。${where}\n配置存在 ${r.file}（权限 600）。`);
    const how = decideAutostart({ flag: a.autostart, platform, tty: deps.tty });
    let on = how === "on";
    if (how === "ask") on = await (deps.ask ?? askYesNo)("开机自动连上？以后不用开终端 (Y/n) ", true);
    if (how === "unsupported") console.log(ONLY_MAC + "，这次不设。");
    if (on) {
      try { await turnAutostartOn(r.file, prog, deps); return; }
      catch (e) { console.log(`开机自启没设成：${explainError(e)}\n这次先在前台连着（终端窗口别关）。`); }
    }
    if (how === "ask") console.log(`好的，不设开机自启。以后想开：${prog} autostart on`);
    if (how === "hint") console.log(`想开机自动连上（不用开终端）：运行 ${prog} autostart on`);
    if (a.start === false) { console.log(`现在运行：${prog} start`); return; }
    console.log("接着连服务器……");
    await runStart(prog, deps);
    return;
  }
  if (a.cmd === "start") { await runStart(prog, deps); return; }
  if (a.cmd === "stop") {
    const l = await stopHolder(configPath());
    if (!l) { console.log("没有在跑的运行器。"); return; }
    console.log(`已停掉（进程 ${l.pid}）。${l.launchd ? `开机自启还开着，下次登录会自己连上；不想要：${prog} autostart off` : ""}`);
    return;
  }
  if (a.cmd === "autostart") {
    const sub = a.positional[0] ?? "status";
    const file = configPath();
    if (sub === "on") { loadConfig(file); await turnAutostartOn(file, prog, deps); return; }
    if (platform !== "darwin" && platform !== "win32") { console.log(ONLY_MAC); return; }
    // @意图#R725(2026-11-03): Windows 的 off / status 走计划任务，Mac 走 launchd
    if (sub === "off") {
      const r = platform === "win32"
        ? await autostartOffWindows({ configFile: file, schtasks: deps.schtasks })
        : await autostartOff({ configFile: file, launchctl: deps.launchctl });
      console.log(r.wasOn ? "已关掉开机自启（后台那个也停了）。" : "本来就没开开机自启。");
      return;
    }
    if (sub === "status") {
      const st = platform === "win32"
        ? await autostartStatusWindows({ configFile: file, schtasks: deps.schtasks })
        : await autostartStatus({ configFile: file, launchctl: deps.launchctl, platform });
      const where = st.task ? `计划任务：${st.task}` : `plist：${st.plist}`;
      console.log(st.installed ? `开机自启：开着（${st.loaded ? (st.pid ? `后台在跑，进程 ${st.pid}` : "已加载，现在没在跑") : "还没加载"}）\n${where}\n日志：${st.log}` : "开机自启：没开");
      for (const p of st.problems) console.log(`注意：${p}`);
      return;
    }
    throw new Error(`autostart 后面只能是 on、off 或 status（${sub} 不认识）`);
  }
  if (a.cmd === "uninstall") {
    const file = configPath();
    if (platform === "darwin") await autostartOff({ configFile: file, launchctl: deps.launchctl }).catch(() => {});
    await stopHolder(file);
    const home = runnerHome();
    if (!otherAutostarts(file).length) {
      rmSync(path.join(home, "bin"), { recursive: true, force: true });
      rmSync(path.join(home, "logs"), { recursive: true, force: true });
    }
    let purge = !!a.purge;
    if (!purge && existsSync(file) && (deps.tty ?? !!(process.stdin.isTTY && process.stdout.isTTY))) {
      purge = await (deps.ask ?? askYesNo)("要连配对信息（令牌）一起删掉吗？删了以后要重新配对 (y/N) ", false);
    }
    if (purge) { rmSync(file, { force: true }); rmSync(lockPath(file), { force: true }); }
    console.log(`已卸载：开机自启关了、本地副本和日志删了。${purge ? `配置也删了（${file}）；记得在网页「我的电脑」里点「断开」作废令牌。` : `配置留着（${file}）；连配置一起删：${prog} uninstall --purge`}`);
    return;
  }
  if (a.cmd === "set-dir") {
    // @意图#R716(2026-11-02): 不靠弹窗也能设目录（无桌面会话 / 弹不出来时应急），走和网页选目录同一套检查
    const file = configPath();
    const bot = a.positional[0];
    const dir = a.positional[1];
    if (!bot || !dir) { console.log(`用法：${prog} set-dir <bot_id> <路径>\n  bot_id 在网页这个 bot 的私聊里、输入框下面「我的电脑」那一行能看到`); process.exitCode = 1; return; }
    let cfg;
    try { cfg = loadConfig(file); } catch (e) { console.log(e?.message ?? String(e)); process.exitCode = 1; return; }
    if (!cfg?.token) { console.log(`还没配对：${file} 里没有令牌。先在网页上配对：${prog} pair <配对码>@<服务器地址>`); process.exitCode = 1; return; }
    let real;
    try { real = await checkDir(dir); } catch (e) { console.log(e?.message ?? String(e)); process.exitCode = 1; return; }
    cfg.bot_dirs = { ...botDirsOf(cfg), [bot]: real };
    delete cfg.dir; // 老格式的单一 dir 不再写回
    saveConfig(cfg, file);
    const l = readLock(file);
    const running = l && pidAlive(l.pid);
    console.log(`已设：${bot} → ${real}`);
    console.log(running ? `运行器正在跑（进程 ${l.pid}），重启后生效：${prog} stop && ${prog} start` : `配置文件：${file}`);
    return;
  }
  if (a.cmd === "status") {
    const file = configPath();
    const cfg = loadConfig(file);
    const d = Object.entries(botDirsOf(cfg));
    const l = readLock(file);
    const run = l && pidAlive(l.pid) ? `在跑（进程 ${l.pid}${l.launchd ? "，开机自启" : ""}）` : "没在跑";
    let auto = "";
    if (platform === "darwin") {
      const st = await autostartStatus({ configFile: file, launchctl: deps.launchctl, platform }).catch(() => null);
      auto = `\n开机自启：${st?.installed ? "开着" : "没开"}${st?.problems?.length ? `（${st.problems.join("；")}）` : ""}`;
    }
    console.log(`服务器：${cfg.server}\n设备：${cfg.device_id}\n运行器版本：${RUNNER_VERSION}\n现在：${run}${auto}\n各 bot 的授权目录：${d.length ? d.map(([b, p]) => `\n  ${b}：${p}`).join("") : "（还没有，连上后在每个 bot 的私聊里点「选择目录」）"}`);
    return;
  }
  // @意图#R729(2026-11-04): 乙：浏览器组件不进运行器的依赖，用户敲这一条才装（网页抽屉里给的就是它）；status 只看文件，不加载
  if (a.cmd === "browser") {
    const sub = a.positional[0] ?? "status";
    if (sub === "install") { await (deps.installBrowser ?? installBrowser)({ log: (t) => console.log(t) }); return; }
    if (sub === "status") {
      const st = browserStatus();
      console.log(st.installed ? `浏览器：装好了（playwright-core ${st.version}）`
        : st.reason === "version_mismatch" ? `浏览器：版本不对（装的是 ${st.version}），重新运行 ${prog} browser install`
          : `浏览器：还没装。运行 ${prog} browser install`);
      return;
    }
    throw new Error(`browser 后面只能是 install 或 status（${sub} 不认识）`);
  }
  if (a.cmd === "version") { console.log(RUNNER_VERSION); return; }
  console.log(usage(prog));
  process.exitCode = a.cmd && a.cmd !== "help" ? 1 : 0;
}

const real = (p) => { try { return realpathSync(p); } catch { return path.resolve(p); } };

/** 这个文件是不是被直接运行的（经符号链接运行也算：两边都换成真实路径再比）。 */
// @意图#R664(2026-10-29): npm 装好的命令是指向源码的符号链接，原来按字面路径比较会判成「不是直接运行」、什么都不做；改成真实路径比较
export function isMainModule(argv1 = process.argv[1], metaUrl = import.meta.url) {
  return !!argv1 && real(argv1) === real(fileURLToPath(metaUrl));
}

/**
 * 用法和提示里怎么称呼自己：npm 装好的（经 bin 里的 agent-hub-runner 链接运行，或文件在 node_modules 里）说 agent-hub-runner，
 * 仓库里直接跑说 node <相对路径>。
 */
// @意图#R666(2026-10-29): npx 跑的（npm 设 npm_lifecycle_event=npx，或文件在 npx 缓存 _npx 目录里）和开机自启的本地副本（~/.agent-runner/bin 下）都写 npx 写法：
// 这两种情况电脑上都没有 agent-hub-runner 这个命令
// @意图#R664(2026-10-29): 用法和配对成功提示按运行方式区分：装好的显示 agent-hub-runner …，仓库里显示 node 写法
export function progName(entry = process.argv[1], cwd = process.cwd(), env = process.env) {
  if (!entry) return PKG_BIN;
  if (isNpx(entry, env)) return NPX_CMD;
  const r = real(entry);
  const bin = real(path.join(runnerHome(env), "bin"));
  if (r === bin || r.startsWith(`${bin}${path.sep}`)) return NPX_CMD;
  if (path.basename(entry) === PKG_BIN) return PKG_BIN;
  if (/[\\/]node_modules[\\/]/.test(r)) return PKG_BIN;
  return `node ${path.relative(cwd, r) || path.basename(r)}`;
}
/** 是不是 npx 跑起来的 */
export function isNpx(entry = process.argv[1], env = process.env) {
  if (env.npm_lifecycle_event === "npx") return true;
  return !!entry && /[\\/]_npx[\\/]/.test(real(entry));
}

// @意图#R666(2026-10-29): 出错时打大白话（权限不够单独说）
if (isMainModule()) {
  main(process.argv.slice(2)).catch((e) => { console.error(explainError(e)); process.exit(1); });
}
