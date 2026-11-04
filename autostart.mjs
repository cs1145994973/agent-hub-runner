// @意图#R666(2026-10-29): Mac 开机自启（king 同意 R666 二丙）：配对后选「是」就写一个 launchd 的 LaunchAgent，之后登录 Mac 自动连上，不用开终端。
// - 不靠 npx 缓存（路径不稳定、会被清）：把运行器自己（零依赖的几份源码 + package.json）复制到 ~/.agent-runner/bin/<版本>/，current 软链指向它；
//   plist 里跑 [node 绝对路径（优先 /opt/homebrew/bin/node、/usr/local/bin/node 这种稳定软链）, ~/.agent-runner/bin/current/runner.mjs, start]，开机不联网也能起来，
//   也不会每次登录自动拉 npm 上的新代码；升级 = 重新跑一次 npx -y agent-hub-runner@latest autostart on。
// - Label com.agenthub.runner；用的不是默认配置（AGENT_RUNNER_CONFIG 指别处）时加配置路径 sha256 前 8 位后缀，一份配置一个后台任务；
//   环境变量写明 AGENT_RUNNER_CONFIG 绝对路径、AGENT_RUNNER_LAUNCHD=1（运行器据此知道自己在后台），PATH 用开启时终端里的（bot 跑的命令要找得到 git、npm 这些）。
// - RunAtLoad；KeepAlive 只在非 0 退出时拉起（被网页断开、令牌失效、被顶掉都是 0 退出，不会被反复拉起）；ThrottleInterval 10 秒；
//   日志 ~/.agent-runner/logs/runner.log（非默认配置 runner-<后缀>.log），每次启动超过 5MB 就清空。
// - launchctl 调用可以换成假的（测试用：参数里传，或环境变量 AGENT_RUNNER_LAUNCHCTL 指一个假程序），目录可以用 AGENT_RUNNER_HOME、AGENT_RUNNER_LAUNCH_AGENTS 换到临时目录。
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
// @意图#R725(2026-11-03): Windows 开机自启用计划任务（schtasks）。和 Mac 一样：登录时拉起、崩溃了重新跑、正常退出不拉起。
import os from "node:os";
import path from "node:path";

export const LABEL = "com.agenthub.runner";
export const LOG_MAX_BYTES = 5 * 1024 * 1024;
export const THROTTLE_S = 10;
/** 复制到 ~/.agent-runner/bin/<版本>/ 的文件（package.json 用来读版本号） */
// @意图#R729(2026-11-04): 多复制 browser.mjs（runner.mjs 要 import 它）
// @意图#R690(2026-11-01): 多复制 changes.mjs（runner.mjs 要 import 它，少了开机自启的副本起不来）
export const COPY_FILES = ["runner.mjs", "ops.mjs", "edit.mjs", "changes.mjs", "browser.mjs", "autostart.mjs", "package.json"];
/** 优先用的稳定 node 路径（Homebrew 升级 node 后这两个软链还在；nvm 的带版本号路径卸了就没了） */
export const STABLE_NODES = ["/opt/homebrew/bin/node", "/usr/local/bin/node"];
export const ONLY_MAC = "开机自启目前只支持 Mac 和 Windows";
// @意图#R725(2026-11-03): Windows 计划任务名前缀。默认配置是 AgentHubRunner，别的配置加路径 sha256 前 8 位，一份配置一个任务。
export const TASK_PREFIX = "AgentHubRunner";

const real = (p) => { try { return realpathSync(p); } catch { return path.resolve(p); } };

/** 运行器自己的目录（配置、副本、日志都在这下面）；测试可用 AGENT_RUNNER_HOME 换掉 */
export const runnerHome = (env = process.env) => env.AGENT_RUNNER_HOME || path.join(os.homedir(), ".agent-runner");
export const defaultConfigFile = (env = process.env) => path.join(runnerHome(env), "config.json");
export const launchAgentsDir = (env = process.env) => env.AGENT_RUNNER_LAUNCH_AGENTS || path.join(os.homedir(), "Library", "LaunchAgents");

/** 默认配置没有后缀；别的配置用绝对路径 sha256 前 8 位 */
export function configTag(configFile, env = process.env) {
  const abs = path.resolve(configFile);
  if (abs === path.resolve(defaultConfigFile(env))) return "";
  return createHash("sha256").update(abs).digest("hex").slice(0, 8);
}
export const labelFor = (configFile, env = process.env) => { const t = configTag(configFile, env); return t ? `${LABEL}.${t}` : LABEL; };
export const plistPathFor = (configFile, env = process.env) => path.join(launchAgentsDir(env), `${labelFor(configFile, env)}.plist`);
export const logFileFor = (configFile, env = process.env) => {
  const t = configTag(configFile, env);
  return path.join(runnerHome(env), "logs", t ? `runner-${t}.log` : "runner.log");
};

/** node 的绝对路径：稳定软链和当前 node 是同一个文件就用软链，否则用当前的 */
export function pickNode(execPath = process.execPath, candidates = STABLE_NODES) {
  const me = real(execPath);
  for (const c of candidates) if (existsSync(c) && real(c) === me) return c;
  return execPath;
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** 生成 LaunchAgent 的 plist（XML） */
export function plistXml({ label, args, env, log }) {
  const envXml = Object.entries(env).map(([k, v]) => `      <key>${esc(k)}</key>\n      <string>${esc(v)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${esc(label)}</string>
    <key>ProgramArguments</key>
    <array>
${args.map((a) => `      <string>${esc(a)}</string>`).join("\n")}
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>${THROTTLE_S}</integer>
    <key>StandardOutPath</key>
    <string>${esc(log)}</string>
    <key>StandardErrorPath</key>
    <string>${esc(log)}</string>
  </dict>
</plist>
`;
}

// @意图#R725(2026-11-03): Windows 建软链要管理员权限（或开开发者模式），小白没有。所以 Windows 用一个 current.txt 记当前版本号，
// 包装脚本读它来找要跑的 runner.mjs。Mac 仍用 current 软链（先建临时链再改名，换的那一下不会断）。
/** 把运行器复制到 <home>/bin/<版本>/。返回要跑的 runner.mjs 路径。 */
export function installCopy({ srcDir, version, env = process.env, platform = process.platform }) {
  const binRoot = path.join(runnerHome(env), "bin");
  const dest = path.join(binRoot, version);
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  if (real(srcDir) !== real(dest)) {
    for (const f of COPY_FILES) {
      const from = path.join(srcDir, f);
      if (existsSync(from)) copyFileSync(from, path.join(dest, f));
    }
  }
  if (platform === "win32") {
    writeFileSync(path.join(binRoot, "current.txt"), version);
    return path.join(dest, "runner.mjs");
  }
  const cur = path.join(binRoot, "current");
  const tmp = path.join(binRoot, `.current-${process.pid}`);
  rmSync(tmp, { force: true });
  symlinkSync(version, tmp);
  renameSync(tmp, cur);
  return path.join(cur, "runner.mjs");
}

/** 默认的 launchctl：返回 { code, stdout, stderr }，不抛错。AGENT_RUNNER_LAUNCHCTL 可换成别的程序（测试用假的，不真加载） */
export function runLaunchctl(args, env = process.env) {
  return new Promise((resolve) => {
    execFile(env.AGENT_RUNNER_LAUNCHCTL || "launchctl", args, { encoding: "utf8" }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }));
  });
}
const uid = () => (typeof process.getuid === "function" ? process.getuid() : 0);

// @意图#R731(2026-11-04): plist 的 PATH 用终端里的，但去掉 npx 临时缓存、各级 node_modules/.bin、npm 自带的 node-gyp-bin 这些会变或会被清的目录；去重保序
export function cleanPath(p) {
  const seen = new Set();
  return String(p || "").split(":").filter((d) => d && !d.includes("/_npx/") && !/\/node_modules\/\.bin\/?$/.test(d) && !d.includes("/node-gyp-bin") && !seen.has(d) && seen.add(d)).join(":") || "/usr/bin:/bin:/usr/sbin:/sbin";
}

/** 加载失败时给小白看的中文说明（带一条能直接复制的修复命令） */
export const bootstrapHelp = (label, raw) => `开机自启没设成：macOS 拒绝加载后台任务（${raw}）。\n可以在终端里复制运行下面这条命令后，再运行一次 autostart on：\n  launchctl enable gui/$(id -u)/${label}\n还不行就重启一下电脑再试；仍然失败请把这段话截图发给我们。`;

/**
 * 开启开机自启：复制自己、写 plist、（先卸掉旧的）再加载。加载后 launchd 马上起一个后台运行器（RunAtLoad）。
 * 返回 { label, plist, script, node, log }。
 */
// @意图#R731(2026-11-04): 小白遇到「任务被 macOS 记成已禁用」（以前 launchctl disable 过，删 plist 也清不掉）时 bootstrap 报 5，自己处理掉：
//   加载前先 launchctl enable（没禁用也无害）；还失败就等 1 秒再 enable + bootstrap 一次（刚 bootout 马上 bootstrap 偶尔也报 5）；仍失败给中文说明和修复命令
export async function autostartOn({ configFile, version, srcDir, execPath = process.execPath, env = process.env, launchctl, platform = process.platform, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  launchctl ??= (a) => runLaunchctl(a, env);
  if (platform !== "darwin") throw new Error(ONLY_MAC);
  const cfg = path.resolve(configFile);
  if (!existsSync(cfg)) throw new Error(`还没配对：没有 ${cfg}，配对成功后才能设开机自启`);
  const script = installCopy({ srcDir, version, env });
  const node = pickNode(execPath);
  const label = labelFor(cfg, env);
  const log = logFileFor(cfg, env);
  mkdirSync(path.dirname(log), { recursive: true, mode: 0o700 });
  const vars = { AGENT_RUNNER_CONFIG: cfg, AGENT_RUNNER_LAUNCHD: "1", PATH: cleanPath(env.PATH), LANG: env.LANG || "en_US.UTF-8" };
  if (env.AGENT_RUNNER_HOME) vars.AGENT_RUNNER_HOME = env.AGENT_RUNNER_HOME;
  const plist = plistPathFor(cfg, env);
  mkdirSync(path.dirname(plist), { recursive: true });
  writeFileSync(plist, plistXml({ label, args: [node, script, "start"], env: vars, log }), { mode: 0o644 });
  await launchctl(["bootout", `gui/${uid()}/${label}`]); // 以前加载过（升级）：先卸掉，没有也不要紧
  let r;
  for (let i = 0; i < 2; i++) {
    if (i) await sleep(1000);
    await launchctl(["enable", `gui/${uid()}/${label}`]);
    r = await launchctl(["bootstrap", `gui/${uid()}`, plist]);
    if (r.code === 0) break;
  }
  if (r.code !== 0) throw new Error(bootstrapHelp(label, `launchctl bootstrap 失败：${(r.stderr || r.stdout).trim() || r.code}`));
  return { label, plist, script, node, log };
}

/** 关掉开机自启：卸载任务（后台那个会被停掉）、删 plist。返回 { wasOn }（原来有没有 plist）。 */
export async function autostartOff({ configFile, env = process.env, launchctl }) {
  launchctl ??= (a) => runLaunchctl(a, env);
  const cfg = path.resolve(configFile);
  const plist = plistPathFor(cfg, env);
  const wasOn = existsSync(plist);
  rmSync(plist, { force: true });
  await launchctl(["bootout", `gui/${uid()}/${labelFor(cfg, env)}`]);
  return { wasOn };
}

/** 开机自启现在的样子：装没装（有没有 plist）、加载没有、后台进程号；plist 里的 node / 脚本找不到就写进 problems */
export async function autostartStatus({ configFile, env = process.env, launchctl, platform = process.platform }) {
  launchctl ??= (a) => runLaunchctl(a, env);
  const cfg = path.resolve(configFile);
  const label = labelFor(cfg, env);
  const plist = plistPathFor(cfg, env);
  const out = { supported: platform === "darwin", installed: existsSync(plist), loaded: false, pid: null, label, plist, log: logFileFor(cfg, env), problems: [] };
  if (!out.supported) return out;
  if (out.installed) {
    const xml = readFileSync(plist, "utf8");
    const args = [...(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml)?.[1] ?? "").matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
    if (args[0] && !existsSync(args[0])) out.problems.push(`找不到 node：${args[0]}（换过 Node 的装法？重新运行 autostart on）`);
    if (args[1] && !existsSync(args[1])) out.problems.push(`找不到运行器副本：${args[1]}（重新运行 autostart on）`);
  }
  const r = await launchctl(["print", `gui/${uid()}/${label}`]);
  if (r.code === 0) {
    out.loaded = true;
    const m = /\bpid = (\d+)/.exec(r.stdout);
    if (m) out.pid = Number(m[1]);
  }
  return out;
}

/** 还有没有别的配置开着自启（uninstall 时决定删不删共用的 bin 副本） */
export function otherAutostarts(configFile, env = process.env) {
  const mine = `${labelFor(configFile, env)}.plist`;
  try { return readdirSync(launchAgentsDir(env)).filter((f) => f.startsWith(LABEL) && f.endsWith(".plist") && f !== mine); } catch { return []; }
}

// @意图#R725(2026-11-03): Windows 开机自启用计划任务，语义对齐 Mac 的 launchd：
// - 触发器是「登录时」（/sc onlogon），跑在用户自己的桌面会话里。不能用 SYSTEM 或开机即跑（那样在 Session 0，选目录的窗口弹不出来）。
// - 退出码不是 0 时重新跑（RestartCount 999、间隔 1 分钟），对齐 KeepAlive 的 SuccessfulExit=false：被网页断开、令牌失效、被顶掉都是 0 退出，不会被反复拉起；崩溃了才会重跑。
// - 不设 /rl highest：普通权限就够，而且提权会弹 UAC，小白配不上。
// - 任务跑一个 .cmd：计划任务的 /tr 不支持带空格的参数和重定向，node 装在 Program Files 里，所以包一层。日志追加到和 Mac 同一个文件。
const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** 计划任务名：默认配置 AgentHubRunner，别的配置加 sha8 后缀（对齐 labelFor） */
export const taskNameFor = (configFile, env = process.env) => { const t = configTag(configFile, env); return t ? `${TASK_PREFIX}-${t}` : TASK_PREFIX; };

/** 计划任务跑的包装脚本：<home>/bin/start-<任务名>.cmd，日志追加到 logFileFor 那个文件 */
export function taskCmdFor(configFile, env = process.env) {
  return path.join(runnerHome(env), "bin", `start-${taskNameFor(configFile, env)}.cmd`);
}

// @意图#R725(2026-11-03): 不靠计划任务的「失败重拉」。实测 schtasks 的 RestartOnFailure 在被 taskkill 强杀时不重拉
// （任务记的结果是 1，但不再起）。所以在包装脚本里自己循环：退出码不是 0 就等 10 秒再跑，对齐 Mac 的
// KeepAlive SuccessfulExit=false。正常退出（被网页断开、令牌失效、Ctrl-C，都是 0）不重跑。
// 脚本路径不写死：从 current.txt 读当前版本号再拼（升级后不用改这个包装脚本）。binDir 是 <home>/bin。
/** 生成包装脚本的内容。node 是绝对路径，配置路径经环境变量传（和 Mac 的 plist 一样）。 */
export function taskCmdText({ node, binDir, configFile, log }) {
  return [
    "@echo off",
    "setlocal EnableDelayedExpansion",
    `set AGENT_RUNNER_CONFIG=${configFile}`,
    "set AGENT_RUNNER_LAUNCHD=1",
    ":loop",
    "set /p VER=<\"" + binDir + "\\current.txt\"",
    "\"" + node + "\" \"" + binDir + "\\!VER!\\runner.mjs\" start >> \"" + log + "\" 2>&1",
    "if %ERRORLEVEL%==0 goto end",
    "timeout /t 10 /nobreak > nul",
    "goto loop",
    ":end",
    "",
  ].join("\r\n");
}

/** 调 schtasks，返回 { code, stdout, stderr }，不抛错。AGENT_RUNNER_SCHTASKS 可换成假程序（测试用）。输出是 GBK，转成 UTF-8。 */
export function runSchtasks(args, env = process.env) {
  return new Promise((resolve) => {
    execFile(env.AGENT_RUNNER_SCHTASKS || "schtasks", args, { encoding: "buffer" }, (err, stdout, stderr) => {
      const dec = (b) => { try { return new TextDecoder("gbk").decode(b); } catch { return String(b ?? ""); } };
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: dec(stdout), stderr: dec(stderr) });
    });
  });
}

/** 开启开机自启（Windows）：复制自己、写包装脚本、建计划任务（登录时跑，失败重跑），马上起一次。返回 { task, cmd, node, log }。 */
export async function autostartOnWindows({ configFile, version, srcDir, execPath = process.execPath, env = process.env, schtasks }) {
  schtasks ??= (a) => runSchtasks(a, env);
  const cfg = path.resolve(configFile);
  if (!existsSync(cfg)) throw new Error(`还没配对：没有 ${cfg}，配对成功后才能设开机自启`);
  const script = installCopy({ srcDir, version, env, platform: "win32" });
  const node = pickNode(execPath);
  const log = logFileFor(cfg, env);
  mkdirSync(path.dirname(log), { recursive: true });
  const cmd = taskCmdFor(cfg, env);
  writeFileSync(cmd, taskCmdText({ node, binDir: path.join(runnerHome(env), "bin"), configFile: cfg, log }));
  const name = taskNameFor(cfg, env);
  const user = env.USERNAME;
  if (!user) throw new Error("开机自启没设成：读不到当前用户名");
  const args = ["/create", "/tn", name, "/tr", cmd, "/sc", "onlogon", "/ru", user, "/rl", "limited", "/f"];
  const r = await schtasks(args);
  if (r.code !== 0) throw new Error(`开机自启没设成：计划任务创建失败（${(r.stderr || r.stdout).trim() || r.code}）`);
  // 崩溃重跑由包装脚本自己的循环做（见 taskCmdText）。这里只补「用电池也跑」，笔记本合盖不中断。
  const ps = `$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Seconds 0); Set-ScheduledTask -TaskName ${psQuote(name)} -Settings $s | Out-Null`;
  await new Promise((resolve) => execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], () => resolve()));
  await schtasks(["/run", "/tn", name]); // 马上起一次，不用等下次登录
  return { task: name, cmd, node, log };
}

/** 关掉开机自启（Windows）：停掉并删计划任务、删包装脚本。返回 { wasOn }。 */
export async function autostartOffWindows({ configFile, env = process.env, schtasks }) {
  schtasks ??= (a) => runSchtasks(a, env);
  const cfg = path.resolve(configFile);
  const name = taskNameFor(cfg, env);
  const cmd = taskCmdFor(cfg, env);
  const wasOn = existsSync(cmd);
  await schtasks(["/end", "/tn", name]);
  await schtasks(["/delete", "/tn", name, "/f"]);
  rmSync(cmd, { force: true });
  return { wasOn };
}

/** 开机自启现在的样子（Windows）：有没有包装脚本、任务在不在、状态。 */
export async function autostartStatusWindows({ configFile, env = process.env, schtasks }) {
  schtasks ??= (a) => runSchtasks(a, env);
  const cfg = path.resolve(configFile);
  const name = taskNameFor(cfg, env);
  const cmd = taskCmdFor(cfg, env);
  const out = { supported: true, installed: existsSync(cmd), loaded: false, pid: null, task: name, cmd, log: logFileFor(cfg, env), problems: [] };
  const r = await schtasks(["/query", "/tn", name, "/fo", "csv"]);
  if (r.code === 0) {
    out.loaded = true;
    const row = r.stdout.split(/\r?\n/).find((l) => l.includes(name));
    if (row && /running/i.test(row)) out.pid = 0; // 计划任务查不到进程号，0 表示在跑但不知道是哪个
  }
  return out;
}

/** 日志超过 max 字节就清空（launchd 用追加方式打开，清空后接着往后写不会乱）。清了返回 true。 */
export function truncateLogIfBig(file, max = LOG_MAX_BYTES) {
  try {
    if (statSync(file).size <= max) return false;
    truncateSync(file, 0);
    return true;
  } catch { return false; }
}
