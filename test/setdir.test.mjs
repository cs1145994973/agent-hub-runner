// @意图#R716(2026-11-02): set-dir 子命令——不靠弹窗也能设授权目录（无桌面会话 / 弹不出来时应急），走和网页选目录同一套检查
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { botDirsOf, configPath, loadConfig, main, saveConfig } from "../runner.mjs";

describe("R716 set-dir", () => {
  let base;
  let file;
  let logs;
  const origLog = console.log;
  const origEnv = process.env.AGENT_RUNNER_CONFIG;
  before(() => {
    base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "r716-setdir-")));
    file = path.join(base, "config.json");
    process.env.AGENT_RUNNER_CONFIG = file;
    saveConfig({ server: "http://127.0.0.1:1", device_id: "dev-x", token: "tok-x", name: "m", bot_dirs: {} }, file);
    console.log = (...a) => logs.push(a.join(" "));
  });
  after(() => {
    console.log = origLog;
    if (origEnv === undefined) delete process.env.AGENT_RUNNER_CONFIG; else process.env.AGENT_RUNNER_CONFIG = origEnv;
    rmSync(base, { recursive: true, force: true });
  });
  const run = async (...argv) => { logs = []; process.exitCode = 0; await main(argv, "runner", { platform: "linux" }); return { out: logs.join("\n"), code: process.exitCode }; };
  const mk = (name) => { const d = path.join(base, name); mkdirSync(d, { recursive: true }); writeFileSync(path.join(d, "f.txt"), "x"); return d; };

  it("D1 设成功：写进配置的 bot_dirs，回显真实路径", async () => {
    const d = mk("proj");
    assert.equal(configPath(), file);
    const r = await run("set-dir", "bot-a", d);
    assert.equal(r.code, 0);
    assert.match(r.out, /已设：bot-a → /);
    assert.deepEqual(botDirsOf(loadConfig(file)), { "bot-a": d });
  });

  it("D2 再设另一个 bot 不覆盖前一个；老格式 dir 不写回", async () => {
    const d = mk("proj2");
    saveConfig({ ...loadConfig(file), dir: "/old/style" }, file);
    const r = await run("set-dir", "bot-b", d);
    assert.equal(r.code, 0);
    const cfg = loadConfig(file);
    assert.deepEqual(botDirsOf(cfg), { "bot-a": path.join(base, "proj"), "bot-b": d });
    assert.equal(cfg.dir, undefined);
  });

  it("D3 路径不存在 / 参数不全：拒绝，配置不动", async () => {
    const before = readFileSync(file, "utf8");
    assert.equal((await run("set-dir", "bot-a", path.join(base, "nope"))).code, 1);
    assert.equal((await run("set-dir", "bot-a")).code, 1);
    assert.equal(readFileSync(file, "utf8"), before);
  });

  it("D4 没配对（没有配置）：提示先配对，不建配置", async () => {
    process.env.AGENT_RUNNER_CONFIG = path.join(base, "missing.json");
    const r = await run("set-dir", "bot-a", mk("proj3"));
    assert.equal(r.code, 1);
    assert.match(r.out, /还没配对/);
    process.env.AGENT_RUNNER_CONFIG = file;
  });

  it("D5 配置文件权限还是 600", async () => {
    await run("set-dir", "bot-a", mk("proj4"));
    const { statSync } = await import("node:fs");
    assert.equal(statSync(file).mode & 0o777, 0o600);
  });
});
