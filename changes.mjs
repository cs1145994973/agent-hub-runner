// @意图#R690(2026-11-01): 私聊里「已改文件 / 已写文件（自动允许）」点开看改动（king 同意 R690）：改动内容只存在你电脑上（运行器配置旁边的 edits/<auto_id>.json，权限 600），
// 服务器库里只记 id。改文件存按行对比（带改前、改后行号和前后 3 行，网页左右对照用），写文件存写进去的内容；存之前先打码（和服务器 redactSecrets 同一套规则，
// 共用测试样例 test/fixtures/redact-cases.json）；每条最多 64 KB（超出截断并标记）；只留 30 天（启动时和每次存时顺手清，最多一小时一次）。存失败只记日志，不影响写改本身。
import fs from "node:fs/promises";
import path from "node:path";

export const CHANGE_ID_RE = /^auto-[0-9a-f]{32}$/;
export const MAX_RECORD_BYTES = 64 * 1024;
export const KEEP_MS = 30 * 24 * 60 * 60_000;
export const CLEAN_EVERY_MS = 60 * 60_000;
export const CONTEXT_LINES = 3;
/** 中间改动部分（去掉首尾相同的行后）行数乘积超过这个就不细算，整块当作删了再加 */
export const MAX_DIFF_CELLS = 4_000_000;

/** 改动记录放在配置文件旁边的 edits/ 里（跟着 AGENT_RUNNER_CONFIG 走，dev 和正式配置各管各的文件，名字是 auto_id 不会撞）。 */
// @意图#R690(2026-11-01): king 定甲：放配置旁边
export const changesDirFor = (configFile) => path.join(path.dirname(configFile), "edits");

// 变量名以 KEY / TOKEN / SECRET / PASSWORD / PASSWD 结尾（API_KEY、db.password、apiKey、token 都算；monkey、tokens 不算）
const NAME = String.raw`(?:(?:[A-Za-z0-9]+[_.-])*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|key|token|secret|password|passwd|Key|Token|Secret|Password)|[a-z][A-Za-z0-9]*(?:Key|Token|Secret|Password))`;
const QUOTED_ASSIGN = new RegExp(String.raw`(^|[^\w.-])(["']?)(${NAME})\2([ \t]*[=:][ \t]*)(["'])([^"'\r\n]+)\5`, "gm");
const LINE_ASSIGN = new RegExp(String.raw`^([ \t]*(?:export[ \t]+)?)(${NAME})([ \t]*[=:][ \t]*)([^\s"'#][^\s#]*)`, "gm");

/**
 * 打码（和服务器 server/src/model-keys.ts 的 redactSecrets 规则一字不差，样例见 test/fixtures/redact-cases.json）：
 * sk- / ghp_ 开头的串、连接串里的密码、私钥块（BEGIN/END 两行留着，中间每行换成 ***，行数不变）、
 * 变量名像密钥的赋值（带引号的值任何位置都打；不带引号的只认行首的 .env / yaml 写法）。
 */
// @意图#R690(2026-11-01): king 定乙：服务器三条规则 + 私钥块 + .env 式 XXX_KEY / TOKEN / SECRET / PASSWORD = 值；打码不改变行数（行号对得上）
export function redactSecrets(text) {
  let s = String(text);
  s = s.replace(/(-----BEGIN [A-Z0-9 ]*-----)([\s\S]*?)(-----END [A-Z0-9 ]*-----)/g, (_m, a, body, b) => a + body.replace(/[^\r\n]+/g, "***") + b);
  s = s.replace(/(-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)((?:(?!-----END )[\s\S])*)$/, (_m, a, body) => a + body.replace(/[^\r\n]+/g, "***")); // 截断了没有 END 的私钥块
  s = s.replace(/(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]+/g, "sk-***").replace(/(?<![A-Za-z0-9])ghp_[A-Za-z0-9_]+/g, "ghp_***")
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@/]+@/gi, "$1:***@");
  s = s.replace(QUOTED_ASSIGN, (m, pre, q1, name, eq, q2, val) => (val === "***" ? m : `${pre}${q1}${name}${q1}${eq}${q2}***${q2}`));
  s = s.replace(LINE_ASSIGN, "$1$2$3***");
  return s;
}

/** 按行拆（去 BOM、换行统一成 LF；末尾换行不算多一行）。 */
export function splitLines(text) {
  let t = String(text);
  if (t.startsWith("\uFEFF")) t = t.slice(1);
  t = t.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (t === "") return [];
  const a = t.split("\n");
  if (a[a.length - 1] === "") a.pop();
  return a;
}

/** 逐行对比：返回每一行 {t:" "|"-"|"+", o:改前行号|null, n:改后行号|null, s:内容}；连着的一段改动里先删后加。 */
// @意图#R690(2026-11-01): 带两边行号，网页既能画左右对照也能画红绿一栏
export function diffLines(a, b) {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let q = 0;
  while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
  const A = a.slice(p, a.length - q), B = b.slice(p, b.length - q);
  const mid = []; // " " / "-" / "+" 序列
  if (A.length && B.length && A.length * B.length <= MAX_DIFF_CELLS) {
    const n = A.length, m = B.length, w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = A[i] === B[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && A[i] === B[j]) { mid.push(" "); i++; j++; }
      else if (j >= m || (i < n && dp[(i + 1) * w + j] >= dp[i * w + j + 1])) { mid.push("-"); i++; }
      else { mid.push("+"); j++; }
    }
  } else {
    for (let i = 0; i < A.length; i++) mid.push("-");
    for (let j = 0; j < B.length; j++) mid.push("+");
  }
  // 连着的改动里先删后加
  const tags = [];
  for (let k = 0; k < mid.length;) {
    if (mid[k] === " ") { tags.push(" "); k++; continue; }
    let d = 0, ad = 0;
    while (k < mid.length && mid[k] !== " ") { if (mid[k] === "-") d++; else ad++; k++; }
    for (let x = 0; x < d; x++) tags.push("-");
    for (let x = 0; x < ad; x++) tags.push("+");
  }
  const out = [];
  let o = 0, nn = 0;
  for (let k = 0; k < p; k++) { out.push({ t: " ", o: o + 1, n: nn + 1, s: a[o] }); o++; nn++; }
  for (const t of tags) {
    if (t === " ") { out.push({ t, o: o + 1, n: nn + 1, s: a[o] }); o++; nn++; }
    else if (t === "-") { out.push({ t, o: o + 1, n: null, s: a[o] }); o++; }
    else { out.push({ t, o: null, n: nn + 1, s: b[nn] }); nn++; }
  }
  for (let k = 0; k < q; k++) { out.push({ t: " ", o: o + 1, n: nn + 1, s: a[o] }); o++; nn++; }
  return out;
}

/** 把逐行对比切成几处改动，每处前后带 ctx 行没变的；两处之间没变的不超过 2×ctx 行就并成一处。 */
export function hunksOf(rows, ctx = CONTEXT_LINES) {
  const idx = [];
  rows.forEach((r, i) => { if (r.t !== " ") idx.push(i); });
  const hunks = [];
  let k = 0;
  while (k < idx.length) {
    let start = idx[k], end = idx[k];
    while (k + 1 < idx.length && idx[k + 1] - end - 1 <= 2 * ctx) { k++; end = idx[k]; }
    k++;
    const from = Math.max(0, start - ctx), to = Math.min(rows.length, end + ctx + 1);
    const lines = rows.slice(from, to);
    let oStart = 1, nStart = 1;
    for (let i = 0; i < from; i++) { if (rows[i].t !== "+") oStart++; if (rows[i].t !== "-") nStart++; }
    hunks.push({ old_start: oStart, new_start: nStart, lines });
  }
  return hunks;
}

const jsonBytes = (v) => Buffer.byteLength(JSON.stringify(v), "utf8") + 1; // 存进去占的字节（加逗号）

/**
 * 生成一条改动记录（存之前先打码、截到 64 KB）。
 * edit：{ v, id, tool, path, at, hunks, added, removed, truncated }；write：{ v, id, tool, path, at, lines, total_lines, chars, truncated }
 */
// @意图#R690(2026-11-01): 改文件存红绿对比（king 定），写文件只存写进去的内容、不存旧文件（king 定乙）；每条最多 64 KB（king 定甲）
export function buildChangeRecord({ id, tool, path: p, before, after, content, at = new Date().toISOString() }) {
  const budget = MAX_RECORD_BYTES - 1024;
  const head = { v: 1, id, tool, path: String(p ?? ""), at };
  if (tool === "write") {
    const text = String(content ?? "");
    const all = splitLines(redactSecrets(text));
    const lines = [];
    let used = 0, truncated = false;
    for (const l of all) {
      const b = jsonBytes(l);
      if (used + b > budget) { truncated = true; break; }
      lines.push(l); used += b;
    }
    return { ...head, lines, total_lines: all.length, chars: text.length, truncated };
  }
  const rows = diffLines(splitLines(redactSecrets(before ?? "")), splitLines(redactSecrets(after ?? "")));
  let added = 0, removed = 0;
  for (const r of rows) { if (r.t === "+") added++; else if (r.t === "-") removed++; }
  const hunks = [];
  let used = 0, truncated = false;
  for (const h of hunksOf(rows)) {
    used += jsonBytes({ old_start: h.old_start, new_start: h.new_start, lines: [] });
    const keep = [];
    for (const l of h.lines) {
      const b = jsonBytes(l);
      if (used + b > budget) { truncated = true; break; }
      keep.push(l); used += b;
    }
    if (keep.length) hunks.push({ ...h, lines: keep });
    if (truncated) break;
  }
  return { ...head, hunks, added, removed, truncated };
}

/** 改动记录的存取和清理（目录用到时才建，700；文件 600）。 */
// @意图#R690(2026-11-01): 只留 30 天（king 定甲）：启动时清一次，每次存时顺手清（最多一小时一次），按文件修改时间算
export function createChangeStore(dir, { now = Date.now, log = () => {} } = {}) {
  let lastClean = 0;
  const fileOf = (id) => path.join(dir, `${id}.json`);
  async function clean(force = false) {
    if (!force && now() - lastClean < CLEAN_EVERY_MS) return 0;
    lastClean = now();
    let names;
    try { names = await fs.readdir(dir); } catch { return 0; }
    let removed = 0;
    for (const f of names) {
      if (!/^auto-[0-9a-f]{32}\.json$/.test(f)) continue;
      try {
        const st = await fs.stat(path.join(dir, f));
        if (now() - st.mtimeMs > KEEP_MS) { await fs.unlink(path.join(dir, f)); removed++; }
      } catch { /* 别的进程删了 */ }
    }
    return removed;
  }
  return {
    dir,
    clean,
    async save(id, record) {
      if (!CHANGE_ID_RE.test(String(id))) throw new Error("改动记录 id 不对");
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const f = fileOf(id);
      await fs.writeFile(f, JSON.stringify(record), { mode: 0o600 });
      await fs.chmod(f, 0o600);
      await clean().catch((e) => log(`清理旧改动记录失败：${e?.message ?? e}`));
    },
    /** 找不到（没存、已清理、id 不对）返回 null */
    async get(id) {
      if (!CHANGE_ID_RE.test(String(id))) return null;
      try { return JSON.parse(await fs.readFile(fileOf(id), "utf8")); } catch { return null; }
    },
  };
}
