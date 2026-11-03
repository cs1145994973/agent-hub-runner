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
import os from "node:os";
import path from "node:path";

export const LABEL = "com.agenthub.runner";
export const LOG_MAX_BYTES = 5 * 1024 * 1024;
export const THROTTLE_S = 10;
/** 复制到 ~/.agent-runner/bin/<版本>/ 的文件（package.json 用来读版本号） */
// @意图#R690(2026-11-01): 多复制 changes.mjs（runner.mjs 要 import 它，少了开机自启的副本起不来）
export const COPY_FILES = ["runner.mjs", "ops.mjs", "edit.mjs", "changes.mjs", "autostart.mjs", "package.json"];
/** 优先用的稳定 node 路径（Homebrew 升级 node 后这两个软链还在；nvm 的带版本号路径卸了就没了） */
export const STABLE_NODES = ["/opt/homebrew/bin/node", "/usr/local/bin/node"];
export const ONLY_MAC = "开机自启目前只支持 Mac";

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

/** 把运行器复制到 <home>/bin/<版本>/，current 软链指过去（先建临时链再改名，换的那一下不会断）。返回 current/runner.mjs 的路径。 */
export function installCopy({ srcDir, version, env = process.env }) {
  const binRoot = path.join(runnerHome(env), "bin");
  const dest = path.join(binRoot, version);
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  if (real(srcDir) !== real(dest)) {
    for (const f of COPY_FILES) {
      const from = path.join(srcDir, f);
      if (existsSync(from)) copyFileSync(from, path.join(dest, f));
    }
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

/**
 * 开启开机自启：复制自己、写 plist、（先卸掉旧的）再加载。加载后 launchd 马上起一个后台运行器（RunAtLoad）。
 * 返回 { label, plist, script, node, log }。
 */
export async function autostartOn({ configFile, version, srcDir, execPath = process.execPath, env = process.env, launchctl, platform = process.platform }) {
  launchctl ??= (a) => runLaunchctl(a, env);
  if (platform !== "darwin") throw new Error(ONLY_MAC);
  const cfg = path.resolve(configFile);
  if (!existsSync(cfg)) throw new Error(`还没配对：没有 ${cfg}，配对成功后才能设开机自启`);
  const script = installCopy({ srcDir, version, env });
  const node = pickNode(execPath);
  const label = labelFor(cfg, env);
  const log = logFileFor(cfg, env);
  mkdirSync(path.dirname(log), { recursive: true, mode: 0o700 });
  const vars = { AGENT_RUNNER_CONFIG: cfg, AGENT_RUNNER_LAUNCHD: "1", PATH: env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin", LANG: env.LANG || "en_US.UTF-8" };
  if (env.AGENT_RUNNER_HOME) vars.AGENT_RUNNER_HOME = env.AGENT_RUNNER_HOME;
  const plist = plistPathFor(cfg, env);
  mkdirSync(path.dirname(plist), { recursive: true });
  writeFileSync(plist, plistXml({ label, args: [node, script, "start"], env: vars, log }), { mode: 0o644 });
  await launchctl(["bootout", `gui/${uid()}/${label}`]); // 以前加载过（升级）：先卸掉，没有也不要紧
  const r = await launchctl(["bootstrap", `gui/${uid()}`, plist]);
  if (r.code !== 0) throw new Error(`开机自启没设成：launchctl bootstrap 失败（${(r.stderr || r.stdout).trim() || r.code}）`);
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

/** 日志超过 max 字节就清空（launchd 用追加方式打开，清空后接着往后写不会乱）。清了返回 true。 */
export function truncateLogIfBig(file, max = LOG_MAX_BYTES) {
  try {
    if (statSync(file).size <= max) return false;
    truncateSync(file, 0);
    return true;
  } catch { return false; }
}
