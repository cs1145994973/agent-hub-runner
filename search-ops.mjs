// @意图#R943(2026-11-24): 运行器上的 grep / find / ls（转发版，pi 内置同名工具搜不到用户电脑）。
// grep 路线二：有 @vscode/ripgrep 的 rg 二进制就用它（args 照 pi 内置），缺二进制/spawn 失败/rg 报错降级纯 Node 同语义。
// find/ls 纯 Node。跨 mac/win/linux 一套代码，不靠系统 grep/find/ls 命令。
// 与 rg 路的已知差异：node 路不解析 .gitignore（只忽略 .git/node_modules），rg 路尊重 .gitignore；details.engine 标明走的哪条。
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInside } from "./ops.mjs";

export const IGNORE_DIRS = new Set([".git", "node_modules"]);
export const MAX_WALK_FILES = 20000;
export const MAX_WALK_DEPTH = 40;
export const GREP_MAX_LINE_LENGTH = 500; // 照 pi truncate.js
export const GREP_DEFAULT_LIMIT = 100;
export const FIND_DEFAULT_LIMIT = 1000;
export const LS_DEFAULT_LIMIT = 500;

const clampLimit = (v, def) => Math.max(1, Math.floor(Number.isFinite(Number(v)) ? Number(v) : def));

/** glob → 正则：** 跨目录、* 单层、? 单字符；其余转义。 */
export function globToRegex(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") { re += ".*"; i++; if (glob[i + 1] === "/") i++; }
      else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** pattern 不含 '/' 时匹配任意深度的文件名（照 pi 语义），含 '/' 时匹配相对路径。 */
export function globMatches(pattern, rel) {
  const re = globToRegex(pattern);
  return pattern.includes("/") ? re.test(rel) : re.test(path.basename(rel));
}

/** 递归遍历：不跟随符号链接、权限不足跳过、忽略 .git/node_modules、深度/文件数上限。 */
export async function* walkFiles(dir, rel = "", depth = 0, state = { files: 0 }) {
  if (depth > MAX_WALK_DEPTH || state.files >= MAX_WALK_FILES) return;
  let ents;
  try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (state.files >= MAX_WALK_FILES) return;
    if (IGNORE_DIRS.has(e.name) || e.isSymbolicLink()) continue;
    const abs = path.join(dir, e.name);
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) yield* walkFiles(abs, r, depth + 1, state);
    else if (e.isFile()) { state.files++; yield { abs, rel: r }; }
  }
}

const looksBinary = (buf) => buf.subarray(0, 8000).includes(0);
const cutLine = (text) => text.length > GREP_MAX_LINE_LENGTH ? { text: text.slice(0, GREP_MAX_LINE_LENGTH), cut: true } : { text, cut: false };

/** 纯 Node grep：逐行匹配 + context 前后行 + limit + 长行截断。lines 元素 {path,line,text,match}。 */
export async function nodeGrep(searchPath, isDir, args, signal) {
  const limit = clampLimit(args.limit, GREP_DEFAULT_LIMIT);
  const context = Math.max(0, Math.floor(Number(args.context) || 0));
  const flags = args.ignoreCase ? "i" : "";
  const re = args.literal ? new RegExp(String(args.pattern).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags) : new RegExp(String(args.pattern), flags);
  const lines = [];
  let matchCount = 0;
  let matchLimitReached = false;
  let linesTruncated = false;
  const files = isDir ? walkFiles(searchPath) : (async function* () { yield { abs: searchPath, rel: path.basename(searchPath) }; })();
  for await (const f of files) {
    if (signal?.aborted) throw new Error("Operation aborted");
    if (matchLimitReached) break;
    let buf;
    try { buf = await fs.readFile(f.abs); } catch { continue; }
    if (looksBinary(buf)) continue;
    const rows = buf.toString("utf8").split(/\r?\n/);
    if (rows[rows.length - 1] === "") rows.pop(); // 结尾换行不算一行（照 rg）
    const emitted = new Set(); // 重叠 context 窗口去重（照 rg）
    const pushCtx = (j) => {
      if (emitted.has(j)) return;
      emitted.add(j);
      const c = cutLine(rows[j]); linesTruncated ||= c.cut;
      lines.push({ path: f.rel, line: j + 1, text: c.text, match: false });
    };
    for (let i = 0; i < rows.length; i++) {
      if (!re.test(rows[i])) continue;
      if (matchCount >= limit) { matchLimitReached = true; break; }
      for (let j = Math.max(0, i - context); j < i; j++) pushCtx(j);
      const m = cutLine(rows[i]); linesTruncated ||= m.cut;
      lines.push({ path: f.rel, line: i + 1, text: m.text, match: true });
      emitted.add(i);
      matchCount++;
      for (let j = i + 1; j <= Math.min(rows.length - 1, i + context); j++) pushCtx(j);
    }
  }
  return { engine: "node", lines, matchLimitReached, linesTruncated };
}

/** rg 路：args 照 pi 内置 grep（--no-config --json --line-number --color=never --hidden + glob/literal/ignoreCase/context）。 */
async function rgGrep(rgPath, searchPath, isDir, args, signal) {
  const limit = clampLimit(args.limit, GREP_DEFAULT_LIMIT);
  const context = Math.max(0, Math.floor(Number(args.context) || 0));
  const argv = ["--no-config", "--json", "--line-number", "--color=never", "--hidden", "--glob", "!node_modules", "--glob", "!.git"];
  if (args.ignoreCase) argv.push("--ignore-case");
  if (args.literal) argv.push("--fixed-strings");
  if (args.glob) argv.push("--glob", String(args.glob).replace(/^(!?)(?:\.\/)+/, "$1"));
  if (context > 0) argv.push("--context", String(context));
  argv.push("--", String(args.pattern), isDir ? "." : searchPath);
  const lines = [];
  let matchCount = 0;
  let matchLimitReached = false;
  let linesTruncated = false;
  await new Promise((resolve, reject) => {
    const child = spawn(rgPath, argv, { cwd: isDir ? searchPath : undefined, stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    let settled = false;
    const settle = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    const stop = () => { if (!child.killed) child.kill(); };
    const onAbort = () => { stop(); settle(reject, new Error("Operation aborted")); };
    signal?.addEventListener("abort", onAbort, { once: true });
    const handle = (event) => {
      const isMatch = event.type === "match";
      if (!isMatch && event.type !== "context") return;
      const p = event.data?.path?.text;
      const n = event.data?.line_number;
      if (!p || typeof n !== "number") return;
      const raw = String(event.data?.lines?.text ?? "").replace(/\r?\n?$/, "");
      const c = cutLine(raw); linesTruncated ||= c.cut;
      const rel = isDir ? path.relative(searchPath, path.resolve(searchPath, p)).split(path.sep).join("/") : path.basename(p);
      if (matchCount >= limit) { if (isMatch) matchLimitReached = true; stop(); return; }
      lines.push({ path: rel, line: n, text: c.text, match: isMatch });
      if (isMatch) matchCount++;
    };
    child.stdout.on("data", (d) => {
      buf += d.toString("utf8");
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        try { handle(JSON.parse(line)); } catch { /* 半行/坏行忽略 */ }
      }
    });
    child.on("error", (e) => { signal?.removeEventListener("abort", onAbort); settle(reject, e); });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (buf.trim()) { try { handle(JSON.parse(buf)); } catch { /* ignore */ } }
      // rg 退出码 1 = 无匹配，正常；>=2 才是真错误（交给降级）
      if (code !== 0 && code !== 1 && !matchLimitReached) settle(reject, new Error(`rg exited with code ${code}`));
      else settle(resolve);
    });
  });
  return { engine: "rg", lines, matchLimitReached, linesTruncated };
}

export async function opGrep(args, root, extra = {}) {
  const pattern = String(args?.pattern ?? "");
  if (!pattern) throw new Error("pattern 是空的");
  const searchPath = await resolveInside(args?.path ?? ".", root);
  const st = await fs.stat(searchPath).catch(() => { throw new Error(`Path not found: ${searchPath}`); });
  const isDir = st.isDirectory();
  let rgPath;
  try { ({ rgPath } = await import("@vscode/ripgrep")); } catch { rgPath = undefined; }
  if (extra.rgPath !== undefined) rgPath = extra.rgPath || undefined; // 测试注入：模拟缺二进制/坏 rg
  if (rgPath) {
    try { return await rgGrep(rgPath, searchPath, isDir, args, extra.signal); }
    catch (e) {
      if (String(e?.message).includes("aborted")) throw e;
      // 缺二进制/spawn 失败/rg 报错 → 降级纯 Node
    }
  }
  return nodeGrep(searchPath, isDir, args, extra.signal);
}

export async function opFind(args, root, extra = {}) {
  const pattern = String(args?.pattern ?? "");
  if (!pattern) throw new Error("pattern 是空的");
  const searchPath = await resolveInside(args?.path ?? ".", root);
  const st = await fs.stat(searchPath).catch(() => { throw new Error(`Path not found: ${searchPath}`); });
  if (!st.isDirectory()) throw new Error(`Not a directory: ${searchPath}`);
  const limit = clampLimit(args?.limit, FIND_DEFAULT_LIMIT);
  const paths = [];
  let resultLimitReached = false;
  for await (const f of walkFiles(searchPath)) {
    if (extra.signal?.aborted) throw new Error("Operation aborted");
    if (!globMatches(pattern, f.rel)) continue;
    if (paths.length >= limit) { resultLimitReached = true; break; }
    paths.push(f.rel);
  }
  return { paths, resultLimitReached };
}

export async function opLs(args, root, extra = {}) {
  const dirPath = await resolveInside(args?.path ?? ".", root);
  const st = await fs.stat(dirPath).catch(() => { throw new Error(`Path not found: ${dirPath}`); });
  if (!st.isDirectory()) throw new Error(`Not a directory: ${dirPath}`);
  const limit = clampLimit(args?.limit, LS_DEFAULT_LIMIT);
  let names;
  try { names = await fs.readdir(dirPath); } catch (e) { throw new Error(`Cannot read directory: ${e.message}`); }
  names.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  const entries = [];
  let entryLimitReached = false;
  for (const name of names) {
    if (extra.signal?.aborted) throw new Error("Operation aborted");
    if (entries.length >= limit) { entryLimitReached = true; break; }
    try {
      const s = await fs.stat(path.join(dirPath, name));
      entries.push({ name, dir: s.isDirectory(), size: s.size, mtime: s.mtime.toISOString() });
    } catch { /* stat 不了的跳过，照 pi */ }
  }
  return { entries, entryLimitReached };
}