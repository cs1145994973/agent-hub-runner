// @意图#R750(2026-11-07): 网页点「升级」，运行器自己拉最新版。测试全部用注入的假下载、假解压、假拉起，不联网、不真起进程。
// 校验对不上、查不到、已经是最新，都不得替换；指令不带参数，版本号自己查。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { integrityOk } from "../autostart.mjs";
import { handleSelfUpdate, selfUpdate } from "../runner.mjs";

const sha512 = (buf) => `sha512-${createHash("sha512").update(buf).digest("base64")}`;

describe("R750 运行器自己升级", () => {
  let base;
  before(() => { base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "r750-upd-"))); });
  after(() => { rmSync(base, { recursive: true, force: true }); });

  it("U1 integrity：sha512 对得上才过；sha1、空的、对不上都拒绝", () => {
    const buf = Buffer.from("包内容");
    assert.equal(integrityOk(buf, sha512(buf)), true);
    assert.equal(integrityOk(buf, "sha1-abc"), false);
    assert.equal(integrityOk(buf, ""), false);
    assert.equal(integrityOk(buf, null), false);
    assert.equal(integrityOk(buf, sha512(Buffer.from("别的"))), false);
  });

  it("U2 校验对不上：不复制、不拉起新进程", async () => {
    const calls = [];
    const r = await selfUpdate({
      env: { AGENT_RUNNER_HOME: path.join(base, "u2") }, platform: "darwin", currentVersion: "0.3.1",
      fetchLatest: async () => ({ version: "0.3.2", integrity: sha512(Buffer.from("真的")), tarball: "https://registry.npmjs.org/x.tgz" }),
      download: async () => Buffer.from("被换掉的"),
      extract: async () => { calls.push("extract"); return base; },
      spawnNext: async () => { calls.push("spawn"); },
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /校验对不上/);
    assert.deepEqual(calls, []);
  });

  it("U3 查不到最新版、下载失败、已经是最新：都不替换", async () => {
    const no = async () => { throw new Error("不该走到这"); };
    assert.equal((await selfUpdate({ fetchLatest: async () => null, download: no, extract: no, spawnNext: no })).ok, false);
    assert.match((await selfUpdate({
      currentVersion: "0.3.2",
      fetchLatest: async () => ({ version: "0.3.2", integrity: "sha512-x", tarball: "x" }),
      download: no, extract: no, spawnNext: no,
    })).error, /已经是最新版/);
    assert.match((await selfUpdate({
      currentVersion: "0.3.1",
      fetchLatest: async () => ({ version: "0.3.2", integrity: sha512(Buffer.from("a")), tarball: "x" }),
      download: async () => { throw new Error("断网"); }, extract: no, spawnNext: no,
    })).error, /下载失败/);
  });

  it("U4 成功：复制到 bin/<版本>/，拉起的是这个版本", async () => {
    const home = path.join(base, "u4");
    const src = path.join(base, "src4");
    mkdirSync(src, { recursive: true });
    writeFileSync(path.join(src, "runner.mjs"), "// new");
    writeFileSync(path.join(src, "package.json"), JSON.stringify({ version: "0.3.2" }));
    const buf = Buffer.from("包");
    let spawned = null;
    const r = await selfUpdate({
      env: { AGENT_RUNNER_HOME: home }, platform: "darwin", currentVersion: "0.3.1",
      fetchLatest: async () => ({ version: "0.3.2", integrity: sha512(buf), tarball: "https://registry.npmjs.org/x.tgz" }),
      download: async () => buf,
      extract: async () => src,
      spawnNext: async (o) => { spawned = o; },
    });
    assert.deepEqual(r, { ok: true, version: "0.3.2" });
    assert.equal(spawned.version, "0.3.2");
    assert.equal(readFileSync(path.join(home, "bin", "0.3.2", "runner.mjs"), "utf8"), "// new");
  });

  it("U5 新版没接上：回失败，不报成功", async () => {
    const src = path.join(base, "src5");
    mkdirSync(src, { recursive: true });
    const buf = Buffer.from("包");
    const r = await selfUpdate({
      env: { AGENT_RUNNER_HOME: path.join(base, "u5") }, platform: "darwin", currentVersion: "0.3.1",
      fetchLatest: async () => ({ version: "0.3.2", integrity: sha512(buf), tarball: "x" }),
      download: async () => buf,
      extract: async () => src,
      spawnNext: async () => { throw new Error("新版没有接上"); },
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /没接上/);
  });

  it("U6 处理 self_update：不给 selfUpdate 传版本号或命令，失败回原因且不要求退出，成功才要求退出", async () => {
    const seen = [];
    const sent = [];
    const quit = await handleSelfUpdate(
      { file: path.join(base, "u6.json"), platform: "darwin", selfUpdate: async (o) => { seen.push(o); return { ok: false, error: "查不到最新版，没有更换" }; } },
      (m) => sent.push(m),
    );
    assert.equal(quit, false);
    assert.equal(sent[0].ok, false);
    assert.match(sent[0].error, /查不到最新版/);
    assert.equal("version" in seen[0], false);
    const sent2 = [];
    const quit2 = await handleSelfUpdate(
      { file: path.join(base, "u6b.json"), platform: "darwin", selfUpdate: async () => ({ ok: true, version: "0.3.2" }) },
      (m) => sent2.push(m),
    );
    assert.equal(quit2, true);
    assert.deepEqual(sent2[0], { type: "self_update_result", ok: true, version: "0.3.2" });
  });
});
