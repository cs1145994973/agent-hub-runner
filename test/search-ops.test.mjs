// @意图#R943(2026-11-24): grep/find/ls 转发版单测：纯 Node 语义、rg 路与 node 路一致、缺 rg/坏 rg 降级、上限。
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { opGrep, opFind, opLs, nodeGrep, globMatches, GREP_MAX_LINE_LENGTH } from "../search-ops.mjs";

let base;
let root;
before(() => {
  base = mkdtempSync(path.join(os.tmpdir(), "r943-search-"));
  root = path.join(base, "proj");
  mkdirSync(path.join(root, "src"), { recursive: true });
  mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
  mkdirSync(path.join(root, ".git"), { recursive: true });
  writeFileSync(path.join(root, "src", "a.ts"), "alpha one\nbeta two\nalpha three\n");
  writeFileSync(path.join(root, "src", "b.ts"), "ALPHA upper\nnothing\n");
  writeFileSync(path.join(root, "top.md"), "alpha top\n");
  writeFileSync(path.join(root, "node_modules", "pkg", "x.ts"), "alpha hidden\n");
  writeFileSync(path.join(root, ".git", "config"), "alpha git\n");
  writeFileSync(path.join(root, "bin.dat"), Buffer.from([0x61, 0x00, 0x62, 0x00])); // 二进制跳
  writeFileSync(path.join(root, "long.txt"), "x".repeat(GREP_MAX_LINE_LENGTH + 50) + " alpha long\n");
  symlinkSync(path.join(root, "src"), path.join(root, "link-dir"));
});
after(() => rmSync(base, { recursive: true, force: true }));

describe("R943 glob 语义", () => {
  it("S1 无 '/' 匹配任意深度文件名；有 '/' 匹配相对路径；** 跨目录", () => {
    assert.equal(globMatches("*.ts", "src/a.ts"), true);
    assert.equal(globMatches("*.ts", "top.md"), false);
    assert.equal(globMatches("src/**/*.ts", "src/deep/x.ts"), true);
    assert.equal(globMatches("src/*.ts", "src/deep/x.ts"), false);
    assert.equal(globMatches("a?ts", "a1ts"), true);
  });
});

describe("R943 纯 Node grep", () => {
  it("S2 行号、忽略 .git/node_modules、跳二进制和符号链接", async () => {
    const r = await nodeGrep(root, true, { pattern: "alpha" }, undefined);
    assert.equal(r.engine, "node");
    const hits = r.lines.filter((l) => l.match).map((l) => `${l.path}:${l.line}`);
    assert.deepEqual(hits.sort(), ["long.txt:1", "src/a.ts:1", "src/a.ts:3", "top.md:1"].sort());
  });
  it("S3 ignoreCase / literal / context / limit / 长行截断", async () => {
    const ci = await nodeGrep(root, true, { pattern: "alpha", ignoreCase: true }, undefined);
    assert.ok(ci.lines.some((l) => l.match && l.path === "src/b.ts"));
    const lit = await nodeGrep(root, true, { pattern: "a.one", literal: true }, undefined);
    assert.equal(lit.lines.filter((l) => l.match).length, 0);
    const ctx = await nodeGrep(root, true, { pattern: "beta", context: 1 }, undefined);
    const ls = ctx.lines.map((l) => `${l.line}${l.match ? ":" : "-"}`);
    assert.deepEqual(ls, ["1-", "2:", "3-"]);
    const lim = await nodeGrep(root, true, { pattern: "alpha", limit: 1 }, undefined);
    assert.equal(lim.lines.filter((l) => l.match).length, 1);
    assert.equal(lim.matchLimitReached, true);
    const long = await nodeGrep(root, true, { pattern: "alpha long" }, undefined);
    assert.equal(long.linesTruncated, true);
    assert.equal(long.lines.find((l) => l.match).text.length, GREP_MAX_LINE_LENGTH);
  });
});

describe("R943 rg 路与降级", () => {
  it("S4 同 fixture 下 rg 路与 node 路命中一致", async () => {
    const rg = await opGrep({ pattern: "alpha", context: 1 }, root, {});
    const nd = await nodeGrep(root, true, { pattern: "alpha", context: 1 }, undefined);
    assert.equal(rg.engine, "rg");
    const key = (r) => r.lines.map((l) => `${l.path}:${l.line}:${l.match}`).sort();
    assert.deepEqual(key(rg), key(nd));
  });
  it("S5 缺 rg 二进制降级 node，结果仍在", async () => {
    const r = await opGrep({ pattern: "alpha" }, root, { rgPath: "" });
    assert.equal(r.engine, "node");
    assert.ok(r.lines.some((l) => l.match));
  });
  it("S6 rg 报错（exit 2）降级 node", async () => {
    const fake = path.join(base, "fake-rg");
    writeFileSync(fake, "#!/bin/sh\nexit 2\n");
    chmodSync(fake, 0o755);
    const r = await opGrep({ pattern: "alpha" }, root, { rgPath: fake });
    assert.equal(r.engine, "node");
    assert.ok(r.lines.some((l) => l.match));
  });
  it("S7 rg 路 glob 与 limit 生效", async () => {
    const r = await opGrep({ pattern: "alpha", glob: "*.ts", limit: 1 }, root, {});
    assert.equal(r.engine, "rg");
    assert.equal(r.lines.filter((l) => l.match).length, 1);
    assert.ok(r.lines.every((l) => l.path.endsWith(".ts")));
  });
});

describe("R943 find / ls", () => {
  it("S8 find glob + 忽略 + limit + 符号链接不跟随", async () => {
    const r = await opFind({ pattern: "*.ts" }, root, {});
    assert.deepEqual(r.paths.sort(), ["src/a.ts", "src/b.ts"]);
    const lim = await opFind({ pattern: "*.ts", limit: 1 }, root, {});
    assert.equal(lim.paths.length, 1);
    assert.equal(lim.resultLimitReached, true);
  });
  it("S9 ls 排序、目录标记、limit、stat 信息", async () => {
    const r = await opLs({}, root, {});
    const names = r.entries.map((e) => e.name);
    assert.deepEqual(names, [...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));
    assert.equal(r.entries.find((e) => e.name === "src").dir, true);
    assert.equal(r.entries.find((e) => e.name === "top.md").dir, false);
    assert.ok(r.entries.find((e) => e.name === "top.md").size > 0);
    const lim = await opLs({ limit: 2 }, root, {});
    assert.equal(lim.entries.length, 2);
    assert.equal(lim.entryLimitReached, true);
  });
  it("S10 路径不存在 / 不是目录 报错清楚", async () => {
    await assert.rejects(() => opFind({ pattern: "*", path: "nope" }, root, {}), /Path not found/);
    await assert.rejects(() => opLs({ path: "top.md" }, root, {}), /Not a directory/);
    await assert.rejects(() => opGrep({ pattern: "" }, root, {}), /pattern 是空的/);
  });
});