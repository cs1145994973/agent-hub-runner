// @意图#R747(2026-11-06): 授权根增加 .claude/skills，兼容 Claude Code 项目技能目录
// @意图#R745(2026-11-06): 从客户已授权目录加载项目规则并按需提供技能
// 只扫授权根：一份 AGENTS/CLAUDE 候选 + .pi/skills + .agents/skills + .claude/skills；不读祖先、不读 ~/.agents / ~/.pi / ~/.claude。
import fs from "node:fs/promises";
import { existsSync, readFileSync, readdirSync, statSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import path from "node:path";

// 路径校验与 ops.mjs 同语义，避免与 ops 循环依赖。
export const inside = (real, root) => real === root || real.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

export async function realOf(abs, depth = 0) {
  if (depth > 40) throw new Error("符号链接太多层");
  try {
    return await fs.realpath(abs);
  } catch (e) {
    if (e?.code !== "ENOENT") throw e;
    let st;
    try { st = lstatSync(abs); } catch { st = undefined; }
    if (st?.isSymbolicLink()) {
      const target = path.resolve(path.dirname(abs), readlinkSync(abs));
      return realOf(target, depth + 1);
    }
    const parent = path.dirname(abs);
    if (parent === abs) throw e;
    return path.join(await realOf(parent, depth + 1), path.basename(abs));
  }
}

export const AGENTS_CANDIDATES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
export const MAX_FILE_BYTES = 128 * 1024;
export const MAX_SKILLS = 100;
export const SKILL_DIRS = [".pi/skills", ".agents/skills", ".claude/skills"];
export const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

export function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function toPosix(p) {
  return p.split(path.sep).join("/");
}

/** 极简 ignore：注释、否定、末尾 /、* 与 **（不含完整 gitignore 语义，够 pi 技能树常用规则）。 */
export function createIgnoreMatcher() {
  const rules = [];
  return {
    add(patterns) {
      for (const raw of patterns) {
        const line = String(raw);
        const trimmed = line.trim();
        if (!trimmed || (trimmed.startsWith("#") && !trimmed.startsWith("\\#"))) continue;
        let negated = false;
        let pattern = line;
        if (pattern.startsWith("!")) { negated = true; pattern = pattern.slice(1); }
        else if (pattern.startsWith("\\!")) pattern = pattern.slice(1);
        if (pattern.startsWith("/")) pattern = pattern.slice(1);
        rules.push({ negated, pattern: pattern.replace(/\\/g, "/"), dirOnly: pattern.endsWith("/") });
      }
    },
    ignores(rel, isDir = false) {
      const target = toPosix(rel).replace(/^\/+/, "");
      let ignored = false;
      for (const r of rules) {
        const pat = r.dirOnly ? r.pattern.slice(0, -1) : r.pattern;
        if (r.dirOnly && !isDir) continue;
        if (matchGlob(pat, target) || matchGlob(pat, target.split("/").pop() || "")) {
          ignored = !r.negated;
        }
      }
      return ignored;
    },
  };
}

function matchGlob(pat, text) {
  if (pat === text) return true;
  if (pat.endsWith("/**")) {
    const base = pat.slice(0, -3);
    return text === base || text.startsWith(base + "/");
  }
  if (pat.includes("**")) {
    const parts = pat.split("**");
    if (parts.length !== 2) return false;
    const [a, b] = parts;
    if (a && !text.startsWith(a.replace(/\/$/, ""))) {
      if (!text.includes("/" + a.replace(/^\/|\/$/g, ""))) return false;
    }
    const rest = a ? text.slice(Math.max(text.indexOf(a.replace(/\/$/, "")) + a.replace(/\/$/, "").length, 0)) : text;
    const needle = b.replace(/^\//, "");
    return !needle || rest.includes(needle) || rest.endsWith(needle.replace(/^\//, ""));
  }
  if (!pat.includes("*") && !pat.includes("?")) {
    return text === pat || text.endsWith("/" + pat);
  }
  const esc = pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
  return new RegExp(`(?:^|/)${esc}$`).test(text) || new RegExp(`^${esc}$`).test(text);
}

function addIgnoreRules(ig, dir, root) {
  const relativeDir = path.relative(root, dir);
  const prefix = relativeDir && relativeDir !== "." ? `${toPosix(relativeDir)}/` : "";
  for (const filename of IGNORE_FILE_NAMES) {
    const ignorePath = path.join(dir, filename);
    if (!existsSync(ignorePath)) continue;
    try {
      const content = readFileSync(ignorePath, "utf8");
      const patterns = content.split(/\r?\n/).map((line) => {
        const trimmed = line.trim();
        if (!trimmed || (trimmed.startsWith("#") && !trimmed.startsWith("\\#"))) return null;
        let pattern = line;
        let negated = false;
        if (pattern.startsWith("!")) { negated = true; pattern = pattern.slice(1); }
        else if (pattern.startsWith("\\!")) pattern = pattern.slice(1);
        if (pattern.startsWith("/")) pattern = pattern.slice(1);
        const prefixed = prefix ? `${prefix}${pattern}` : pattern;
        return negated ? `!${prefixed}` : prefixed;
      }).filter(Boolean);
      if (patterns.length) ig.add(patterns);
    } catch { /* ignore unreadable */ }
  }
}

/**
 * 小型 frontmatter：只认 name / description / disable-model-invocation（及 camelCase）。
 * 支持单双引号、| / > / |- / >- / |> / >| 多行块。
 */
export function parseSkillFrontmatter(raw) {
  const text = stripBom(String(raw ?? ""));
  if (!text.startsWith("---")) return null;
  const nl = text.indexOf("\n");
  if (nl < 0) return null;
  const end = text.indexOf("\n---", nl);
  if (end < 0) return null;
  const body = text.slice(nl + 1, end);
  const out = {};
  const lines = body.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) { i += 1; continue; }
    const key = m[1];
    let val = m[2];
    if (val === "" || /^[|>](?:[+-]\d?|\d[+-]?)$/.test(val) || val === "|>" || val === ">|") {
      const block = [];
      i += 1;
      while (i < lines.length) {
        const L = lines[i];
        if (L === "" || L.startsWith(" ") || L.startsWith("\t")) {
          block.push(L.replace(/^  /, "").replace(/^\t/, ""));
          i += 1;
          continue;
        }
        if (/^[A-Za-z0-9_-]+\s*:/.test(L)) break;
        block.push(L);
        i += 1;
      }
      while (block.length && block[block.length - 1] === "") block.pop();
      out[key] = block.join("\n");
      continue;
    }
    if (val.startsWith('"')) {
      // 双引号：优先按 JSON 字符串解（支持 \" \\ \n）；失败再剥一层皮
      try { out[key] = JSON.parse(val); }
      catch {
        out[key] = val.length >= 2 && val.endsWith('"') ? val.slice(1, -1) : val.slice(1);
      }
    } else if (val.startsWith("'")) {
      // 单引号：YAML 里 '' 表示一个 '
      let s = val.endsWith("'") ? val.slice(1, -1) : val.slice(1);
      out[key] = s.replace(/''/g, "'");
    } else if (val === "true") out[key] = true;
    else if (val === "false") out[key] = false;
    else out[key] = val;
    i += 1;
  }
  return out;
}

function skillFromFile(filePath) {
  let raw;
  try { raw = readFileSync(filePath, "utf8"); } catch { return { skill: null, notice: `无法读取技能文件：${filePath}` }; }
  let bytes;
  try { bytes = Buffer.byteLength(raw, "utf8"); } catch { bytes = raw.length; }
  if (bytes > MAX_FILE_BYTES) {
    return { skill: null, notice: `技能文件超过 ${MAX_FILE_BYTES} 字节，已跳过：${filePath}` };
  }
  const fm = parseSkillFrontmatter(raw);
  const declared = path.basename(filePath) === "SKILL.md";
  if (!fm) return { skill: null, notice: declared ? `技能缺少有效 YAML frontmatter，已跳过：${filePath}` : null };
  const description = typeof fm.description === "string" ? fm.description.trim().slice(0, 1024) : "";
  if (!description) return { skill: null, notice: declared ? `技能缺少 description，已跳过：${filePath}` : null };
  const parentDirName = path.basename(path.dirname(filePath));
  const name = typeof fm.name === "string" && fm.name.trim() ? fm.name.trim() : parentDirName;
  const disable = fm["disable-model-invocation"] === true || fm.disableModelInvocation === true;
  return {
    skill: {
      name,
      description,
      filePath,
      baseDir: path.dirname(filePath),
      disableModelInvocation: disable,
      _bytes: Buffer.byteLength(JSON.stringify({ name, description, filePath, baseDir: path.dirname(filePath) }), "utf8"),
    },
    notice: null,
  };
}

function markSkillsCapped(acc, detail) {
  if (acc.capped) return;
  acc.capped = true;
  acc.stopped = true;
  acc.notices.push(detail || `技能超过 ${MAX_SKILLS} 个上限，已停止发现`);
}

async function ensureInside(abs, authRoot, notices, label) {
  let real;
  try { real = await realOf(abs); } catch (e) {
    notices.push(`无法解析${label}：${abs}（${e?.code ?? e?.message ?? e}）`);
    return null;
  }
  if (!inside(real, authRoot)) {
    notices.push(`目录外路径已拒绝：${label}（授权目录是 ${authRoot}）`);
    return null;
  }
  return real;
}

async function loadSkillsFromDirInternal(dir, includeRootFiles, ig, root, acc, authRoot) {
  if (!existsSync(dir)) return;
  if (acc.skills.length >= MAX_SKILLS) { markSkillsCapped(acc); return; }
  // 循环 symlink 指向已扫过的目录时跳过，不能卡住运行器事件循环。
  if (acc.visited.has(dir)) return;
  acc.visited.add(dir);
  addIgnoreRules(ig, dir, root);
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }

  // SKILL.md 优先：有则加载并停止向子目录递归（pi 行为）
  for (const entry of entries) {
    if (entry.name !== "SKILL.md") continue;
    const fullPath = path.join(dir, entry.name);
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try { isFile = statSync(fullPath).isFile(); } catch { continue; }
    }
    const relPath = toPosix(path.relative(root, fullPath));
    if (!isFile || ig.ignores(relPath, false)) continue;
    const realFile = await ensureInside(fullPath, authRoot, acc.notices, relPath || entry.name);
    if (!realFile) return; // 越界 symlink：记 notice，本目录当作技能根已处理完
    const { skill, notice } = skillFromFile(realFile);
    if (notice) acc.notices.push(notice);
    if (skill) {
      if (acc.total + skill._bytes > MAX_TOTAL_BYTES) {
        acc.notices.push(`技能总大小将超过 ${MAX_TOTAL_BYTES} 字节，已停止发现：${fullPath}`);
        acc.stopped = true;
        return;
      }
      if (acc.skills.length >= MAX_SKILLS) { markSkillsCapped(acc); return; }
      if (acc.names.has(skill.name)) acc.notices.push(`技能重名，已跳过后一份：${skill.name}（${skill.filePath}）`);
      if (!acc.names.has(skill.name)) {
        acc.names.add(skill.name);
        acc.total += skill._bytes;
        const { _bytes, ...rest } = skill;
        acc.skills.push(rest);
      }
    }
    return; // 有 SKILL.md 不再递归
  }

  for (const entry of entries) {
    if (acc.stopped || acc.skills.length >= MAX_SKILLS) return;
    // 技能树内部仍跳过隐藏项；根上的 .pi / .agents / .claude 由 SKILL_DIRS 显式进入，不会走到这里
    if (entry.name.startsWith(".")) continue;
    if (entry.name === "node_modules") continue;
    const fullPath = path.join(dir, entry.name);
    let isDirectory = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        const st = statSync(fullPath);
        isDirectory = st.isDirectory();
        isFile = st.isFile();
      } catch { continue; }
    }
    const relPath = toPosix(path.relative(root, fullPath));
    if (ig.ignores(relPath, isDirectory)) continue;
    if (isDirectory) {
      const realDir = await ensureInside(fullPath, authRoot, acc.notices, relPath || entry.name);
      if (!realDir) continue; // 越界目录 symlink：跳过并已记 notice
      await loadSkillsFromDirInternal(realDir, false, ig, root, acc, authRoot);
      continue;
    }
    if (!isFile || !includeRootFiles || !entry.name.endsWith(".md")) continue;
    const realFile = await ensureInside(fullPath, authRoot, acc.notices, relPath || entry.name);
    if (!realFile) continue;
    const { skill, notice } = skillFromFile(realFile);
    if (notice) acc.notices.push(notice);
    if (!skill) continue;
    if (acc.total + skill._bytes > MAX_TOTAL_BYTES) {
      acc.notices.push(`技能总大小将超过 ${MAX_TOTAL_BYTES} 字节，已停止发现：${fullPath}`);
      acc.stopped = true;
      return;
    }
    if (acc.skills.length >= MAX_SKILLS) { markSkillsCapped(acc); return; }
    if (acc.names.has(skill.name)) acc.notices.push(`技能重名，已跳过后一份：${skill.name}（${skill.filePath}）`);
    if (!acc.names.has(skill.name)) {
      acc.names.add(skill.name);
      acc.total += skill._bytes;
      const { _bytes, ...rest } = skill;
      acc.skills.push(rest);
    }
  }
}

async function resolveRootFile(root, name) {
  const abs = path.join(root, name);
  if (!existsSync(abs)) return null;
  let st;
  try { st = statSync(abs); } catch { return null; }
  if (!st.isFile()) return null;
  let real;
  try { real = await realOf(abs); } catch (e) {
    return { error: `无法解析路径：${name}（${e?.code ?? e?.message ?? e}）` };
  }
  if (!inside(real, root)) return { error: `目录外路径已拒绝：${name}（授权目录是 ${root}）` };
  return { real, size: st.size };
}

/**
 * 在授权根目录发现项目上下文。无路径入参；越界 symlink 拒绝。
 * @returns {{ kind: 'project_context', contextFiles: {path,content}[], skills: object[], notices: string[] }}
 */
// @意图#R747(2026-11-06): 授权根增加 .claude/skills，兼容 Claude Code 项目技能目录
// @意图#R745(2026-11-06): 从客户已授权目录加载项目规则并按需提供技能
export async function discoverProjectContext(root) {
  const notices = [];
  const contextFiles = [];
  let total = 0;

  for (const name of AGENTS_CANDIDATES) {
    const got = await resolveRootFile(root, name);
    if (!got) continue;
    if (got.error) { notices.push(got.error); break; }
    if (got.size > MAX_FILE_BYTES) {
      notices.push(`${name} 超过 ${MAX_FILE_BYTES} 字节，未注入项目规则（避免撑爆提示）`);
      break;
    }
    if (total + got.size > MAX_TOTAL_BYTES) {
      notices.push(`${name} 会使总大小超过 ${MAX_TOTAL_BYTES} 字节，未注入项目规则`);
      break;
    }
    let raw;
    try { raw = await fs.readFile(got.real, "utf8"); } catch (e) {
      notices.push(`无法读取 ${name}：${e?.message ?? e}`);
      break;
    }
    const content = stripBom(raw);
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_FILE_BYTES) {
      notices.push(`${name} 超过 ${MAX_FILE_BYTES} 字节，未注入项目规则（避免撑爆提示）`);
      break;
    }
    contextFiles.push({ path: got.real, content });
    total += bytes;
    break; // 只取最高优先级一份
  }

  const acc = { skills: [], notices, names: new Set(), visited: new Set(), total, stopped: false, capped: false };
  for (const rel of SKILL_DIRS) {
    if (acc.stopped) break;
    const dir = path.join(root, rel);
    if (!existsSync(dir)) continue;
    let realDir;
    try { realDir = await realOf(dir); } catch (e) {
      notices.push(`无法解析技能目录 ${rel}：${e?.code ?? e?.message ?? e}`);
      continue;
    }
    if (!inside(realDir, root)) {
      notices.push(`目录外路径已拒绝：${rel}（授权目录是 ${root}）`);
      continue;
    }
    const ig = createIgnoreMatcher();
    // authRoot 用授权根（非 skills 子根），越界 symlink 相对整棵授权树判断
    await loadSkillsFromDirInternal(realDir, true, ig, realDir, acc, root);
  }

  return {
    kind: "project_context",
    contextFiles,
    skills: acc.skills,
    notices,
  };
}

/** ops 入口：忽略任何路径参数，只扫授权根。 */
// @意图#R747(2026-11-06): 授权根增加 .claude/skills，兼容 Claude Code 项目技能目录
// @意图#R745(2026-11-06): 从客户已授权目录加载项目规则并按需提供技能
export async function opContextSnapshot(_args, root) {
  return discoverProjectContext(root);
}
