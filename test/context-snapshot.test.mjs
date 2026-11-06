// @意图#R747(2026-11-06): 授权根增加 .claude/skills，兼容 Claude Code 项目技能目录
// @意图#R745(2026-11-06): 从客户已授权目录加载项目规则并按需提供技能
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { runOp } from "../ops.mjs";
import {
  AGENTS_CANDIDATES, MAX_FILE_BYTES, MAX_SKILLS, MAX_TOTAL_BYTES,
  discoverProjectContext, parseSkillFrontmatter, stripBom,
} from "../project-context.mjs";


/** R747：临时 fixture 只落在 agent-hub/spikes/.tmp（禁止 agent-hub/data / 系统 TMPDIR）。 */
const SPIKES_TMP = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "spikes", ".tmp");
function freshSpikeTmp(prefix) {
  mkdirSync(SPIKES_TMP, { recursive: true });
  return realpathSync(mkdtempSync(path.join(SPIKES_TMP, prefix)));
}

let base, root, outside;
before(() => {
  base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "r745-ctx-")));
  root = path.join(base, "auth");
  outside = path.join(base, "outside");
  mkdirSync(root);
  mkdirSync(outside);
});
after(() => rmSync(base, { recursive: true, force: true }));

function write(rel, content) {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

describe("R745 context_snapshot", () => {
  it("C1 AGENTS 候选优先级：override > AGENTS.md > CLAUDE.md", async () => {
    write("CLAUDE.md", "claude");
    write("AGENTS.md", "agents");
    write("AGENTS.override.md", "override");
    const r = await runOp("context_snapshot", { path: "/etc/passwd" }, root); // 路径参数必须被忽略
    assert.equal(r.kind, "project_context");
    assert.equal(r.contextFiles.length, 1);
    assert.equal(r.contextFiles[0].content, "override");
    assert.ok(path.isAbsolute(r.contextFiles[0].path));
    assert.ok(r.contextFiles[0].path.startsWith(root));
    rmSync(path.join(root, "AGENTS.override.md"));
    const r2 = await discoverProjectContext(root);
    assert.equal(r2.contextFiles[0].content, "agents");
    rmSync(path.join(root, "AGENTS.md"));
    const r3 = await discoverProjectContext(root);
    assert.equal(r3.contextFiles[0].content, "claude");
    for (const n of AGENTS_CANDIDATES) {
      const f = path.join(root, n);
      if (existsSync(f)) rmSync(f);
    }
  });

  it("C2 BOM 剥掉；超大 AGENTS 进 notices 且不进 contextFiles", async () => {
    write("AGENTS.md", "\uFEFFhello-bom");
    const r = await discoverProjectContext(root);
    assert.equal(r.contextFiles[0].content, "hello-bom");
    assert.equal(stripBom("\uFEFFx"), "x");
    rmSync(path.join(root, "AGENTS.md"));
    write("AGENTS.md", "x".repeat(MAX_FILE_BYTES + 10));
    const r2 = await discoverProjectContext(root);
    assert.equal(r2.contextFiles.length, 0);
    assert.ok(r2.notices.some((n) => n.includes("未注入项目规则")));
    rmSync(path.join(root, "AGENTS.md"));
  });

  it("C3 YAML frontmatter：引号、缩进多行、缺 description 丢掉", () => {
    const fm = parseSkillFrontmatter(["---", 'name: "my-skill"', "description: |>", "  line1", "  line2", "disable-model-invocation: true", "---", "body"].join("\n"));
    assert.equal(fm.name, "my-skill");
    assert.match(fm.description, /line1/);
    assert.equal(fm["disable-model-invocation"], true);
    assert.equal(parseSkillFrontmatter(["---", "description:", "  合法的缩进多行", "---"].join("\n")).description, "合法的缩进多行");
    assert.equal(parseSkillFrontmatter(["---", "description: " + JSON.stringify(String.raw`escaped " quote and \ path`), "---"].join("\n")).description, String.raw`escaped " quote and \ path`);
    assert.equal(parseSkillFrontmatter(["---", "name: " + JSON.stringify(String.raw`Test" with \path`), "---"].join("\n")).name, String.raw`Test" with \path`);
    assert.ok(!parseSkillFrontmatter(["---", "name: x", "---"].join("\n")).description);
    assert.equal(parseSkillFrontmatter(["---", "name: 'it''s fine'", "---"].join("\n")).name, "it's fine");
  });

  it("C4 技能发现：.pi + .agents、有 SKILL.md 停止递归、根 standalone .md、ignore、上限", async () => {
    write(".pi/skills/alpha/SKILL.md", `---
name: alpha
description: Alpha skill
---
SECRET_BODY_SHOULD_NOT_RETURN`);
    write(".pi/skills/alpha/nested/SKILL.md", `---
name: nested-should-not
description: should not appear because parent has SKILL.md
---
`);
    write(".pi/skills/plain.md", `---
name: plain-root
description: standalone at skills root
---
`);
    write(".agents/skills/beta/SKILL.md", `---
name: beta
description: "Beta from agents"
disableModelInvocation: true
---
`);
    write(".pi/skills/ignored/SKILL.md", `---
name: ignored-skill
description: should be ignored
---
`);
    write(".pi/skills/.gitignore", "ignored/\n");
    const r = await discoverProjectContext(root);
    const names = r.skills.map((s) => s.name).sort();
    assert.ok(names.includes("alpha"));
    assert.ok(names.includes("plain-root"));
    assert.ok(names.includes("beta"));
    assert.ok(!names.includes("nested-should-not"));
    assert.ok(!names.includes("ignored-skill"));
    const alpha = r.skills.find((s) => s.name === "alpha");
    assert.ok(path.isAbsolute(alpha.filePath));
    assert.equal(alpha.baseDir, path.dirname(alpha.filePath));
    assert.ok(!JSON.stringify(r).includes("SECRET_BODY"));
    const beta = r.skills.find((s) => s.name === "beta");
    assert.equal(beta.disableModelInvocation, true);

    // 100 skills 上限
    for (let i = 0; i < MAX_SKILLS + 5; i++) {
      write(`.pi/skills/mass/s${i}/SKILL.md`, `---
name: mass-${i}
description: mass skill ${i}
---
`);
    }
    const r2 = await discoverProjectContext(root);
    assert.equal(r2.skills.length, MAX_SKILLS);
    assert.ok(r2.notices.some((n) => n.includes(String(MAX_SKILLS))));
  });

  it("C4b 仅 .agents/skills 也能发现（不依赖 .pi）", async () => {
    const clean = realpathSync(mkdtempSync(path.join(os.tmpdir(), "r745-agents-")));
    mkdirSync(path.join(clean, ".agents", "skills", "solo"), { recursive: true });
    writeFileSync(path.join(clean, ".agents", "skills", "solo", "SKILL.md"), `---
name: agents-solo
description: only agents tree
---
`);
    const r = await discoverProjectContext(clean);
    assert.ok(r.skills.some((s) => s.name === "agents-solo"), JSON.stringify(r.skills));
    rmSync(clean, { recursive: true, force: true });
  });

  it("C4c 仅 .claude/skills 也能发现（不依赖 .pi / .agents）", async () => {
    const clean = freshSpikeTmp("r747-claude-");
    assert.ok(clean.startsWith(SPIKES_TMP + path.sep) || clean.startsWith(realpathSync(SPIKES_TMP) + path.sep), clean);
    assert.ok(!clean.includes(`${path.sep}agent-hub${path.sep}data${path.sep}`), clean);
    mkdirSync(path.join(clean, ".claude", "skills", "solo"), { recursive: true });
    writeFileSync(path.join(clean, ".claude", "skills", "solo", "SKILL.md"), `---
name: claude-solo
description: only claude tree
---
SECRET_CLAUDE_BODY`);
    const r = await discoverProjectContext(clean);
    assert.ok(r.skills.some((s) => s.name === "claude-solo"), JSON.stringify(r.skills));
    const s = r.skills.find((x) => x.name === "claude-solo");
    assert.ok(path.isAbsolute(s.filePath));
    assert.equal(s.baseDir, path.dirname(s.filePath));
    assert.ok(!JSON.stringify(r).includes("SECRET_CLAUDE_BODY"));
    rmSync(clean, { recursive: true, force: true });
  });

  it("C4d 三目录同名：按 .pi → .agents → .claude 发现顺序保留先者并跳过后份", async () => {
    const clean = freshSpikeTmp("r747-order-");
    for (const [rel, desc] of [
      [".pi/skills/dup/SKILL.md", "from-pi"],
      [".agents/skills/dup/SKILL.md", "from-agents"],
      [".claude/skills/dup/SKILL.md", "from-claude"],
    ]) {
      const abs = path.join(clean, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, `---
name: dup
description: ${desc}
---
`);
    }
    const r = await discoverProjectContext(clean);
    const hits = r.skills.filter((s) => s.name === "dup");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].description, "from-pi");
    assert.ok(hits[0].filePath.includes(`${path.sep}.pi${path.sep}skills${path.sep}`));
    const dupNotices = r.notices.filter((n) => n.includes("重名") && n.includes("dup"));
    assert.ok(dupNotices.length >= 2, JSON.stringify(r.notices));
    rmSync(clean, { recursive: true, force: true });
  });

  it("C4e .claude 缺 description / 无效 frontmatter 跳过并 notices", async () => {
    const clean = freshSpikeTmp("r747-bad-");
    mkdirSync(path.join(clean, ".claude", "skills", "nodesc"), { recursive: true });
    writeFileSync(path.join(clean, ".claude", "skills", "nodesc", "SKILL.md"), ["---", "name: nodesc", "---"].join("\n"));
    mkdirSync(path.join(clean, ".claude", "skills", "nofm"), { recursive: true });
    writeFileSync(path.join(clean, ".claude", "skills", "nofm", "SKILL.md"), "no frontmatter at all\n");
    mkdirSync(path.join(clean, ".claude", "skills", "ok"), { recursive: true });
    writeFileSync(path.join(clean, ".claude", "skills", "ok", "SKILL.md"), `---
name: ok-claude
description: valid
---
`);
    const r = await discoverProjectContext(clean);
    assert.ok(r.skills.some((s) => s.name === "ok-claude"));
    assert.ok(!r.skills.some((s) => s.name === "nodesc" || s.name === "nofm"));
    assert.ok(r.notices.some((n) => n.includes("description")));
    assert.ok(r.notices.some((n) => n.includes("frontmatter")));
    rmSync(clean, { recursive: true, force: true });
  });

  it("C5b .claude 越界 symlink 与循环 symlink", async () => {
    const clean = freshSpikeTmp("r747-sym-");
    const auth = path.join(clean, "auth");
    const out = path.join(clean, "out");
    mkdirSync(auth); mkdirSync(out);
    mkdirSync(path.join(out, "skills", "evil"), { recursive: true });
    writeFileSync(path.join(out, "skills", "evil", "SKILL.md"), `---
name: evil-claude
description: outside
---
`);
    mkdirSync(path.join(auth, ".claude"), { recursive: true });
    symlinkSync(path.join(out, "skills"), path.join(auth, ".claude", "skills"));
    let r = await discoverProjectContext(auth);
    assert.ok(!r.skills.some((s) => s.name === "evil-claude"));
    assert.ok(r.notices.some((n) => n.includes("目录外") || n.includes("无法解析")));
    rmSync(path.join(auth, ".claude", "skills"), { force: true });

    mkdirSync(path.join(auth, ".claude", "skills", "a", "child"), { recursive: true });
    symlinkSync(path.join(auth, ".claude", "skills"), path.join(auth, ".claude", "skills", "a", "child", "loop"), "dir");
    writeFileSync(path.join(auth, ".claude", "skills", "a", "SKILL.md"), `---
name: loop-claude
description: safe
---
`);
    r = await Promise.race([
      discoverProjectContext(auth),
      new Promise((_, reject) => setTimeout(() => reject(new Error("循环扫描未停止")), 3000)),
    ]);
    assert.ok(r.skills.some((s) => s.name === "loop-claude"));
    rmSync(clean, { recursive: true, force: true });
  });

  it("C5 越界 symlink：整棵 skills 目录、嵌套目录、SKILL.md 文件；绝对 real path", async () => {
    const clean = realpathSync(mkdtempSync(path.join(os.tmpdir(), "r745-sym-")));
    const auth = path.join(clean, "auth");
    const out = path.join(clean, "out");
    mkdirSync(auth); mkdirSync(out);
    mkdirSync(path.join(out, "skills", "evil"), { recursive: true });
    writeFileSync(path.join(out, "skills", "evil", "SKILL.md"), `---
name: evil
description: outside
---
`);
    // 整棵 .pi/skills -> 外
    mkdirSync(path.join(auth, ".pi"), { recursive: true });
    symlinkSync(path.join(out, "skills"), path.join(auth, ".pi", "skills"));
    let r = await discoverProjectContext(auth);
    assert.ok(r.notices.some((n) => n.includes("目录外") || n.includes("无法解析")));
    assert.ok(!r.skills.some((s) => s.name === "evil"));
    rmSync(path.join(auth, ".pi", "skills"), { force: true });

    // 合法 skills 根 + 嵌套目录 symlink 外
    mkdirSync(path.join(auth, ".pi", "skills"), { recursive: true });
    mkdirSync(path.join(out, "nested"), { recursive: true });
    writeFileSync(path.join(out, "nested", "SKILL.md"), `---
name: nested-evil
description: outside dir
---
`);
    symlinkSync(path.join(out, "nested"), path.join(auth, ".pi", "skills", "link-dir"));
    // 合法 skills 根 + SKILL.md 文件 symlink 外
    writeFileSync(path.join(out, "file-skill.md"), `---
name: file-evil
description: outside file
---
`);
    mkdirSync(path.join(auth, ".pi", "skills", "link-file"), { recursive: true });
    symlinkSync(path.join(out, "file-skill.md"), path.join(auth, ".pi", "skills", "link-file", "SKILL.md"));
    // 同树内正常技能仍可见
    mkdirSync(path.join(auth, ".pi", "skills", "good"), { recursive: true });
    writeFileSync(path.join(auth, ".pi", "skills", "good", "SKILL.md"), `---
name: good
description: inside
---
`);
    r = await discoverProjectContext(auth);
    assert.ok(r.skills.some((s) => s.name === "good"));
    assert.ok(!r.skills.some((s) => s.name === "nested-evil" || s.name === "file-evil"));
    assert.ok(r.notices.some((n) => n.includes("目录外")));
    rmSync(clean, { recursive: true, force: true });
  });

  it("C7 循环 symlink 停止；长描述截断；SKILL 缺描述明确通知", async () => {
    const clean = realpathSync(mkdtempSync(path.join(os.tmpdir(), "r745-loop-")));
    mkdirSync(path.join(clean, ".pi", "skills", "a", "child"), { recursive: true });
    symlinkSync(path.join(clean, ".pi", "skills"), path.join(clean, ".pi", "skills", "a", "child", "loop"), "dir");
    writeFileSync(path.join(clean, ".pi", "skills", "a", "SKILL.md"), ["---", "name: loop-safe", `description: ${"x".repeat(1200)}`, "---"].join("\n"));
    mkdirSync(path.join(clean, ".pi", "skills", "bad"), { recursive: true });
    writeFileSync(path.join(clean, ".pi", "skills", "bad", "SKILL.md"), ["---", "name: bad", "---"].join("\n"));
    const r = await Promise.race([discoverProjectContext(clean), new Promise((_, reject) => setTimeout(() => reject(new Error("循环扫描未停止")), 3000))]);
    assert.equal(r.skills.find((s) => s.name === "loop-safe").description.length, 1024);
    assert.ok(r.notices.some((n) => n.includes("缺") && n.includes("description")));
    rmSync(clean, { recursive: true, force: true });
  });

  it("C6 未知 op 仍拒绝；context_snapshot 无路径也能跑空根", async () => {
    const empty = realpathSync(mkdtempSync(path.join(os.tmpdir(), "r745-empty-")));
    const r = await runOp("context_snapshot", {}, empty);
    assert.equal(r.kind, "project_context");
    assert.deepEqual(r.contextFiles, []);
    assert.deepEqual(r.skills, []);
    await assert.rejects(runOp("nope", {}, empty), /未知操作/);
    rmSync(empty, { recursive: true, force: true });
  });
});
