// @意图#R636(2026-10-27): 运行器在你电脑上真正执行 read / write / edit / bash。路径只在这里判断（S6 结论：服务器不解析用户电脑的路径）：
// 先按授权目录换算成真实路径（解开符号链接，包括指向不存在目标的符号链接），不在授权目录里的一律拒绝；bash 的工作目录就是授权目录。
// 第一轮没有沙箱（king 定的范围）：bash 里的命令本身能碰到目录外的东西，只能靠你看清批准卡片再点。
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { editText } from "./edit.mjs";
import { opContextSnapshot } from "./project-context.mjs";

export const MAX_READ_BYTES = 20 * 1024 * 1024;
/** bash 没给 timeout 时的默认上限（秒），到点杀掉整个进程组。 */
export const DEFAULT_BASH_TIMEOUT_S = 300;

/** 把 bot 给的路径按授权目录换成绝对路径（~ 指你的家目录，相对路径相对授权目录；去掉开头的 @，和 pi 一样）。 */
// @意图#R636(2026-10-27): 相对路径一律相对授权目录
export function expandPath(p, root) {
  let s = String(p).replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
  if (s.startsWith("@")) s = s.slice(1);
  if (s === "~") s = os.homedir();
  else if (s.startsWith("~/")) s = path.join(os.homedir(), s.slice(2));
  return path.resolve(root, s);
}

/** 真实路径：存在的直接 realpath；不存在的找到最近的已存在上级再拼回去；悬空的符号链接按它指向的地方算。 */
// @意图#R636(2026-10-27): 挡住 ../、越界符号链接、悬空符号链接（写的时候会顺着链接写到目录外）
export async function realOf(abs, depth = 0) {
  if (depth > 40) throw new Error("符号链接太多层");
  try {
    return await fs.realpath(abs);
  } catch (e) {
    if (e?.code !== "ENOENT") throw e;
    let st;
    try { st = await fs.lstat(abs); } catch { st = undefined; }
    if (st?.isSymbolicLink()) {
      const target = path.resolve(path.dirname(abs), await fs.readlink(abs));
      return realOf(target, depth + 1);
    }
    const parent = path.dirname(abs);
    if (parent === abs) throw e;
    return path.join(await realOf(parent, depth + 1), path.basename(abs));
  }
}

export const inside = (real, root) => real === root || real.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/** 换算并检查：在授权目录里返回真实路径，不在就抛「目录外路径已拒绝」。 */
// @意图#R636(2026-10-27): 授权目录外的路径一律拒绝
export async function resolveInside(p, root) {
  if (typeof p !== "string" || !p.trim()) throw new Error("路径是空的");
  let real;
  try { real = await realOf(expandPath(p, root)); } catch (e) { throw new Error(`无法解析路径：${p}（${e?.code ?? e?.message ?? e}）`); }
  if (!inside(real, root)) throw new Error(`目录外路径已拒绝：${p}（授权目录是 ${root}）`);
  return real;
}

function imageMime(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  const head = buf.subarray(0, 6).toString("latin1");
  if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return "image/bmp";
  return null;
}

/** read：返回整份文字（截断由服务器照 pi 原版做）或图片。 */
// @意图#R636(2026-10-27): 读文件不用批准，但同样只能读授权目录里的
export async function opRead(args, root) {
  const real = await resolveInside(args.path, root);
  const st = await fs.stat(real);
  if (st.isDirectory()) throw new Error(`${args.path} 是目录，不是文件（看目录里有什么用 ${process.platform === "win32" ? "PowerShell 的 Get-ChildItem" : "bash 的 ls"}）`);
  if (st.size > MAX_READ_BYTES) throw new Error(`${args.path} 太大（${st.size} 字节），超过 ${MAX_READ_BYTES} 字节；用 bash 的 head/sed 看一部分`);
  const buf = await fs.readFile(real);
  const mime = imageMime(buf);
  if (mime) return { kind: "image", mime, data: buf.toString("base64") };
  return { kind: "text", text: buf.toString("utf8") };
}

/** write：建好上级目录再整份写入。 */
// @意图#R690(2026-11-01): 写成功后交给 onChange 存一份改动记录（写进去的内容），存记录的事不影响写本身
// @意图#R636(2026-10-27): 写文件（已经过批准，只执行这一次）
export async function opWrite(args, root, { onChange } = {}) {
  if (typeof args.content !== "string") throw new Error("content 必须是文字");
  const real = await resolveInside(args.path, root);
  await fs.mkdir(path.dirname(real), { recursive: true });
  await fs.writeFile(real, args.content, "utf8");
  await onChange?.({ tool: "write", path: args.path, content: args.content });
  return { bytes: Buffer.byteLength(args.content, "utf8") };
}

/** edit：和 pi 原版同样的精确替换。 */
// @意图#R690(2026-11-01): 写回成功后把改前（读到的原文）、改后（写回的内容）交给 onChange 算对比、存记录：同一个函数里拿到的两份，不会和别的改动串
// @意图#R636(2026-10-27): 改文件（已经过批准，只执行这一次）
export async function opEdit(args, root, { onChange } = {}) {
  if (!Array.isArray(args.edits) || args.edits.length === 0) throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
  const real = await resolveInside(args.path, root);
  let raw;
  try { raw = await fs.readFile(real, "utf8"); } catch (e) { throw new Error(`Could not edit file: ${args.path}. Error code: ${e?.code ?? "unknown"}.`); }
  const next = editText(raw, args.edits, args.path);
  await fs.writeFile(real, next, "utf8");
  await onChange?.({ tool: "edit", path: args.path, before: raw, after: next });
  return { replaced: args.edits.length };
}

function killGroup(child, platform = process.platform) {
  if (!child.pid) return;
  // @意图#R721(2026-11-02): Windows 没有负进程组，要 taskkill /T /F 才能连子进程一起杀
  if (platform === "win32") {
    try { spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); } catch { /* 进程已经没了 */ }
    try { child.kill("SIGKILL"); } catch { /* ignore */ }
    return;
  }
  try { process.kill(-child.pid, "SIGKILL"); } catch { /* 进程组已经没了 */ }
  try { child.kill("SIGKILL"); } catch { /* ignore */ }
}

/**
 * 按平台选执行器。
 * Windows 上没有 bash：用 PowerShell，整段脚本转 UTF-16LE base64 传给 -EncodedCommand。
 * 这样一次解决两个实现时踩到的坑：① 中文参数走 -Command 会按 ANSI 代码页解码成乱码；
 * ② powershell -Command 的退出码恒为 0，得靠脚本尾巴的 exit $LASTEXITCODE 才拿得到真实结果。
 */
// @意图#R721(2026-11-02): Windows 用 PowerShell 跑命令（客户是小白，不能要求装 Git Bash）
export function shellFor(command, platform = process.platform) {
  if (platform === "win32") {
    // $ProgressPreference 必须关：不加的话 PowerShell 会把进度流序列化成 #< CLIXML ... 写到 stderr，模型会看到一堆垃圾。
    // `2>&1 | ForEach-Object { "$_" }`：错误也要转成纯字符串，否则 ErrorRecord 会被序列化成 CLIXML；
    // 用管道逐条处理，保持边跑边输出（不缓冲）。
    const script = [
      "$ProgressPreference = 'SilentlyContinue'",
      "[Console]::OutputEncoding=[Text.Encoding]::UTF8",
      "$OutputEncoding=[Text.Encoding]::UTF8",
      "& {",
      command,
      '} 2>&1 | ForEach-Object { "$_" }',
      "exit $LASTEXITCODE",
      "",
    ].join("\n");
    return {
      file: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-OutputFormat", "Text", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    };
  }
  return { file: "bash", args: ["-c", command] };
}

/**
 * bash：在授权目录里用你终端的环境变量跑（服务器的环境变量不下发）。输出边跑边交给 onData；
 * 超时或 signal 中止时杀掉整个进程组。返回 { exitCode, timedOut, aborted }。
 */
// @意图#R636(2026-10-27): 跑命令（已经过批准，只执行这一次），有超时，超时杀进程
export function opBash(args, root, { onData, signal, platform = process.platform } = {}) {
  const command = args.command;
  if (typeof command !== "string" || !command.trim()) return Promise.reject(new Error("command 是空的"));
  let timeoutS = DEFAULT_BASH_TIMEOUT_S;
  if (args.timeout !== undefined && args.timeout !== null) {
    const t = Number(args.timeout);
    if (!Number.isFinite(t) || t <= 0) return Promise.reject(new Error("Invalid timeout: must be a finite number of seconds"));
    timeoutS = t;
  }
  const shell = shellFor(command, platform);
  return new Promise((resolve, reject) => {
    const child = spawn(shell.file, shell.args, { cwd: root, detached: platform !== "win32", stdio: ["ignore", "pipe", "pipe"], env: process.env, windowsHide: true });
    let timedOut = false;
    let aborted = false;
    const timer = setTimeout(() => { timedOut = true; killGroup(child, platform); }, timeoutS * 1000);
    const onAbort = () => { aborted = true; killGroup(child, platform); };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    child.stdout.on("data", (d) => onData?.(d));
    child.stderr.on("data", (d) => onData?.(d));
    const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); };
    child.on("error", (e) => { done(); reject(e); });
    child.on("close", (code, sig) => {
      done();
      const exitCode = code ?? (sig ? 128 + (os.constants.signals[sig] ?? 0) : 1);
      resolve({ exitCode, timedOut, aborted, timeout: timeoutS });
    });
  });
}

/** 按 op 分派；未知 op 拒绝。 */
// @意图#R690(2026-11-01): write、edit 也收 extra（onChange 存改动记录）
// @意图#R745(2026-11-06): 另加只读 context_snapshot（无路径入参）
// @意图#R636(2026-10-27): 协议里原有四种工具调用
// @意图#R745(2026-11-06): 从客户已授权目录加载项目规则并按需提供技能
export function runOp(op, args, root, extra) {
  const a = args && typeof args === "object" ? args : {};
  if (op === "read") return opRead(a, root);
  if (op === "write") return opWrite(a, root, extra);
  if (op === "edit") return opEdit(a, root, extra);
  if (op === "bash") return opBash(a, root, extra);
  if (op === "context_snapshot") return opContextSnapshot(a, root); // 固定扫授权根，忽略路径参数
  return Promise.reject(new Error(`未知操作 ${op}`));
}
