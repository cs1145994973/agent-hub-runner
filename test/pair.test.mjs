// @意图#R666(2026-10-29): pair 默认配完直接 start：P3、P4 里只配对的改用 --no-start；--start 照样认（P4）；用法里写 --no-start
// @意图#R663(2026-10-29): 加 P4 pair <码> --start：配对成功后不退出、直接接着连服务器（进 start），Ctrl-C / SIGTERM 退出码 0；用法文字有 --start
// @意图#R640(2026-10-27): pair 去掉 --dir：带了不报错、照常配对，请求和配置里都没有目录（返回 dirIgnored，命令行打印提示）；配置里 bot_dirs 是空表
// @意图#R639(2026-10-27已废弃): 配对不再弹窗、不要求目录（king 定乙，替换 R637 的配对弹窗）；给了 --dir 照旧检查（根目录拒绝、不请求服务器）（R640 去掉 --dir）
// @意图#R637(2026-10-27已废弃): pair 没写 --dir 时弹窗选目录；取消不请求服务器；写了 --dir 不弹窗（R639 改掉了配对弹窗）
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { PAIR_DIR_IGNORED, pair } from "../runner.mjs";

describe("R640 配对不选目录、不收 --dir", () => {
  let base, srv, server;
  const reqs = [];
  before(async () => {
    base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "r639-pair-")));
    srv = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => { body += String(d); });
      req.on("end", () => {
        reqs.push({ url: req.url, body: JSON.parse(body || "{}") });
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ device_id: "dev-test", token: "tok-test" }));
      });
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    server = `http://127.0.0.1:${srv.address().port}`;
  });
  after(async () => {
    await new Promise((r) => srv.close(r));
    rmSync(base, { recursive: true, force: true });
  });

  it("P1 不带目录：照样配对，请求里不带 dir，配置里 bot_dirs 是空表、没有 dir（权限 600）", async () => {
    reqs.length = 0;
    const file = path.join(base, "p1.json");
    const r = await pair({ code: "CODE1", server, name: "m" }, file);
    assert.equal(r.dirIgnored, false);
    assert.equal(reqs.length, 1);
    assert.equal(reqs[0].url, "/devices/pair");
    assert.equal(reqs[0].body.code, "CODE1");
    assert.equal("dir" in reqs[0].body, false);
    const cfg = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(cfg.bot_dirs, {});
    assert.equal("dir" in cfg, false);
    assert.equal(cfg.token, "tok-test");
    assert.equal(statSync(file).mode & 0o777, 0o600);
  });

  it("P2 带了 dir（哪怕是根目录、不存在的）：不报错、照常配对，但目录不用：请求和配置里都没有，返回 dirIgnored", async () => {
    reqs.length = 0;
    for (const [i, dir] of [base, "/", path.join(base, "没有这个")].entries()) {
      const file = path.join(base, `p2-${i}.json`);
      const r = await pair({ code: `CODE2${i}`, dir, server, name: "m" }, file);
      assert.equal(r.dirIgnored, true);
      const cfg = JSON.parse(readFileSync(file, "utf8"));
      assert.deepEqual(cfg.bot_dirs, {});
      assert.equal("dir" in cfg, false);
    }
    assert.equal(reqs.length, 3);
    for (const q of reqs) assert.equal("dir" in q.body, false);
  });

  it("P3 命令行 pair <码> --dir x：打印「目录请连上后在每个 bot 的私聊里选」，照常配对、退出码 0；用法文字里没有 --dir", async () => {
    const run = promisify(execFile); // 假服务器在本进程里，不能用 spawnSync（会卡住事件循环）
    reqs.length = 0;
    const bin = fileURLToPath(new URL("../runner.mjs", import.meta.url));
    const file = path.join(base, "p3.json");
    const r = await run(process.execPath, [bin, "pair", "CODE3", "--no-start", "--dir", base, "--server", server], { encoding: "utf8", env: { ...process.env, AGENT_RUNNER_CONFIG: file } });
    assert.ok(r.stdout.includes(PAIR_DIR_IGNORED));
    assert.ok(r.stdout.includes("配对成功"));
    assert.equal(reqs.length, 1);
    assert.equal("dir" in reqs[0].body, false);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).bot_dirs, {});
    const u = await run(process.execPath, [bin], { encoding: "utf8" });
    assert.ok(u.stdout.includes("用法"));
    assert.equal(u.stdout.includes("--dir"), false);
  });
  it("P4 命令行 pair <码> --start：配对成功后不退出，接着连服务器（连不上就说断了、要重连）；SIGTERM 退出码 0；不带 --start 仍然提示再运行 start", async () => {
    reqs.length = 0;
    const bin = fileURLToPath(new URL("../runner.mjs", import.meta.url));
    const file = path.join(base, "p4.json");
    const ch = spawn(process.execPath, [bin, "pair", "CODE4", "--start", "--server", server], { env: { ...process.env, AGENT_RUNNER_CONFIG: file } });
    let out = "";
    ch.stdout.on("data", (d) => { out += String(d); });
    ch.stderr.on("data", (d) => { out += String(d); });
    const exited = new Promise((r) => { ch.on("exit", (c) => r(c)); });
    try {
      const deadline = Date.now() + 8000;
      while (!out.includes("和服务器的连接断了") && Date.now() < deadline && ch.exitCode === null) await new Promise((r) => setTimeout(r, 50));
      assert.equal(ch.exitCode, null, `进程不该自己退出：${out}`);
      assert.ok(out.includes("配对成功"), out);
      assert.ok(out.includes("接着连服务器"), out);
      assert.equal(out.includes("现在运行："), false);
      assert.ok(out.includes("和服务器的连接断了"), out); // 假服务器不接 WebSocket：说明已经进了 start
      assert.equal(reqs.filter((q) => q.url === "/devices/pair").length, 1);
      assert.ok(reqs.some((q) => q.url === "/devices/ws"), "start 去连了 /devices/ws");
      assert.equal(JSON.parse(readFileSync(file, "utf8")).token, "tok-test");
    } finally { ch.kill("SIGTERM"); }
    assert.equal(await exited, 0);
    const run = promisify(execFile);
    const r = await run(process.execPath, [bin, "pair", "CODE5", "--no-start", "--server", server], { encoding: "utf8", env: { ...process.env, AGENT_RUNNER_CONFIG: path.join(base, "p5.json") } });
    assert.ok(r.stdout.includes("现在运行："));
    const u = await run(process.execPath, [bin], { encoding: "utf8" });
    assert.ok(u.stdout.includes("--no-start"));
  });
});
