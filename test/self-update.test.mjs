// @意图#R750(2026-11-07): 网页点「升级」，运行器自己拉最新版。测试全部用注入的假下载、假解压、假拉起，不联网、不真起进程。
// 校验对不上、查不到、已经是最新，都不得替换；指令不带参数，版本号自己查。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { integrityOk, switchCurrent } from "../autostart.mjs";
import { handleSelfUpdate, pointCurrentAtSelf, selfUpdate, spawnUpdated } from "../runner.mjs";

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

  it("U7 R839：Mac/Windows 自启换装由独立新版进程 autostart on；旧 runner 不亲自 bootout；前台仍 start", async () => {
    for (const platform of ["darwin", "win32"]) {
      const home = path.join(base, `u7-${platform}`);
      const file = path.join(base, `u7-${platform}.json`);
      let call;
      let unref = false;
      await spawnUpdated({
        version: "0.10.1", file, platform,
        env: { AGENT_RUNNER_HOME: home, AGENT_RUNNER_LAUNCHD: "1" },
        spawnFn: (...args) => { call = args; return { unref: () => { unref = true; } }; },
        wait: async () => ({ pid: 123 }),
      });
      assert.equal(call[0], process.execPath);
      assert.deepEqual(call[1], [path.join(home, "bin", "0.10.1", "runner.mjs"), "autostart", "on"]);
      assert.equal(call[2].detached, true);
      assert.equal(call[2].stdio, "ignore");
      assert.equal(call[2].env.AGENT_RUNNER_CONFIG, file);
      assert.equal(call[2].env.AGENT_RUNNER_LAUNCHD, "");
      assert.equal(unref, true);
    }
    let foreground;
    await spawnUpdated({
      version: "0.10.1", file: path.join(base, "u7-front.json"), platform: "darwin",
      env: { AGENT_RUNNER_HOME: path.join(base, "u7-front"), AGENT_RUNNER_LAUNCHD: "" },
      spawnFn: (...args) => { foreground = args; return { unref: () => {} }; },
      wait: async () => ({ pid: 124 }),
    });
    assert.deepEqual(foreground[1].slice(1), ["start"]);
  });

  // @意图#R977(2026-11-25): 跨版本升级回归。旧版的白名单比新包少（0.10.x 没有 official.mjs / oauth.bundle.mjs / search-ops.mjs），
  // 以前拿旧白名单去筛新包，装出来的副本缺模块、一启动就 ERR_MODULE_NOT_FOUND，于是「新版没接上」。
  it("U8 拷什么以新包自己的 package.json files 为准：新版本新增的模块不会被旧白名单删掉，装出来能启动", async () => {
    const home = path.join(base, "u8");
    const src = path.join(base, "src8");
    mkdirSync(path.join(src, "bin"), { recursive: true });
    // 新包：files 里既有旧版知道的，也有旧版压根不知道的
    const newFiles = ["runner.mjs", "ops.mjs", "autostart.mjs", "search-ops.mjs", "official.mjs", "oauth.bundle.mjs", "brand-new.mjs", "bin/agent-hub-runner.mjs"];
    for (const f of newFiles) writeFileSync(path.join(src, f), `${f}\n`);
    writeFileSync(path.join(src, "package.json"), JSON.stringify({ version: "9.9.9", files: newFiles }));
    // 包里多余的东西（README、没声明的文件）不该跟过去
    writeFileSync(path.join(src, "README.md"), "readme");
    writeFileSync(path.join(src, "stray.mjs"), "stray");
    const buf = Buffer.from("包");
    const r = await selfUpdate({
      env: { AGENT_RUNNER_HOME: home }, platform: "darwin", currentVersion: "0.3.1",
      fetchLatest: async () => ({ version: "9.9.9", integrity: sha512(buf), tarball: "https://registry.npmjs.org/x.tgz" }),
      download: async () => buf,
      extract: async () => src,
      spawnNext: async () => {},
    });
    assert.deepEqual(r, { ok: true, version: "9.9.9" });
    const dest = path.join(home, "bin", "9.9.9");
    for (const f of newFiles) assert.ok(existsSync(path.join(dest, f)), `新版本声明的 ${f} 必须复制过去`);
    assert.ok(existsSync(path.join(dest, "bin", "agent-hub-runner.mjs")), "子目录结构要保留");
    assert.equal(existsSync(path.join(dest, "README.md")), false);
    assert.equal(existsSync(path.join(dest, "stray.mjs")), false);
  });

  // @意图#R977(2026-11-25): 失败不能把「当前版本」指到没验证过的新副本，否则 launchd 会一直去跑它。
  it("U9 新版没接上时当前版本指针不动；新版真起来自己换了才换", async () => {
    const home = path.join(base, "u9");
    const src = path.join(base, "src9");
    mkdirSync(src, { recursive: true });
    writeFileSync(path.join(src, "runner.mjs"), "// new");
    writeFileSync(path.join(src, "package.json"), JSON.stringify({ version: "9.9.9", files: ["runner.mjs"] }));
    // 先摆一个「现在在跑的版本」
    mkdirSync(path.join(home, "bin", "1.0.0"), { recursive: true });
    switchCurrent({ version: "1.0.0", env: { AGENT_RUNNER_HOME: home }, platform: "darwin" });
    assert.equal(readlinkSync(path.join(home, "bin", "current")), "1.0.0");
    const buf = Buffer.from("包");
    const common = {
      env: { AGENT_RUNNER_HOME: home }, platform: "darwin", currentVersion: "1.0.0",
      fetchLatest: async () => ({ version: "9.9.9", integrity: sha512(buf), tarball: "x" }),
      download: async () => buf,
      extract: async () => src,
    };
    const bad = await selfUpdate({ ...common, spawnNext: async () => { throw new Error("新版没有接上"); } });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /没接上/);
    assert.equal(readlinkSync(path.join(home, "bin", "current")), "1.0.0", "失败时绝不能把 current 换到新版");
    // 成功路：旧版只摆文件＋拉起；指针由新版自己拿到锁后校正（这里用 pointCurrentAtSelf 代表新版那一步）
    const good = await selfUpdate({ ...common, spawnNext: async ({ version }) => {
      assert.equal(readlinkSync(path.join(home, "bin", "current")), "1.0.0", "拉起新版之前指针必须还是旧的");
      pointCurrentAtSelf({ version, env: common.env, hereDir: path.join(home, "bin", version), platform: "darwin" });
    } });
    assert.deepEqual(good, { ok: true, version: "9.9.9" });
    assert.equal(readlinkSync(path.join(home, "bin", "current")), "9.9.9");
    // @意图#R977(2026-11-25): 旧版自己**不**碰指针。新版拿锁但还没校正指针时，selfUpdate 返回后指针应仍是旧的；
    //   如果旧版又偷偷写了一份（两份各写一次），这里就会变成 9.9.9——锁住「写 current 只有一处」。
    const home2 = path.join(base, "u9b");
    const env2 = { AGENT_RUNNER_HOME: home2 };
    mkdirSync(path.join(home2, "bin", "1.0.0"), { recursive: true });
    switchCurrent({ version: "1.0.0", env: env2, platform: "darwin" });
    const r = await selfUpdate({
      env: env2, platform: "darwin", currentVersion: "1.0.0",
      fetchLatest: async () => ({ version: "9.9.9", integrity: sha512(buf), tarball: "x" }),
      download: async () => buf, extract: async () => src,
      spawnNext: async () => {}, // 新版起来了，但还没走到校正指针那一步
    });
    assert.deepEqual(r, { ok: true, version: "9.9.9" });
    assert.equal(readlinkSync(path.join(home2, "bin", "current")), "1.0.0", "旧版不能自己写指针，写 current 只能有一处");
  });

  // @意图#R977(2026-11-25): 新版拿到锁后自己把指针指向自己；不在这份副本里跑的（npx 缓存/源码目录）不能碰指针。
  it("U10 新版启动时只在自己就是 bin/<版本>/ 里跑才校正 current；npx/源码目录跑的不动", () => {
    const home = path.join(base, "u10");
    const env = { AGENT_RUNNER_HOME: home };
    const dest = path.join(home, "bin", "3.3.3");
    mkdirSync(dest, { recursive: true });
    mkdirSync(path.join(home, "bin", "1.1.1"), { recursive: true });
    switchCurrent({ version: "1.1.1", env, platform: "darwin" });
    // 不在自己的副本里跑（如 npx 缓存）：不动
    assert.equal(pointCurrentAtSelf({ version: "3.3.3", env, hereDir: path.join(base, "npx-cache"), platform: "darwin" }), false);
    assert.equal(readlinkSync(path.join(home, "bin", "current")), "1.1.1");
    // 就在自己的副本里跑：指向自己
    assert.equal(pointCurrentAtSelf({ version: "3.3.3", env, hereDir: dest, platform: "darwin" }), true);
    assert.equal(readlinkSync(path.join(home, "bin", "current")), "3.3.3");
    // 已经指着自己：不重复动（返回 false，不报错）
    assert.equal(pointCurrentAtSelf({ version: "3.3.3", env, hereDir: dest, platform: "darwin" }), false);
  });
});
