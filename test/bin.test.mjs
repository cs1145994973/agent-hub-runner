// @意图#R722(2026-11-03): B5 版本跟着 package.json 改成 0.1.3（904c90c 发 0.1.3 时漏改，测试一直挂着）
// @意图#R690(2026-11-01): B5 版本 0.1.2、files 多 changes.mjs；B 系列复制的源码也带上它
// @意图#R666(2026-10-29): 用法改成 pair <配对码>@<服务器地址> [--no-start]；B4 只配对用 --no-start；B5 版本 0.1.1、files 多 autostart.mjs
// @意图#R664(2026-10-29): 做成 npm 小工具后的运行方式：经符号链接运行（npm 装好的命令就是链接）照样执行；
// 装好的（bin 里叫 agent-hub-runner 的链接、或文件在 node_modules 里）用法写 agent-hub-runner，仓库里直接跑写 node <相对路径>；
// package.json 的 bin / files / engines；pair 不带 --start 的「现在运行：」提示也按运行方式写。
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isMainModule, PKG_BIN, progName } from "../runner.mjs";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const runnerFile = path.join(root, "runner.mjs");
const binFile = path.join(root, "bin", "agent-hub-runner.mjs");

describe("R664 npm 小工具的运行方式", () => {
  let tmp;
  before(() => { tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "r664-bin-"))); });
  after(() => rmSync(tmp, { recursive: true, force: true }));

  it("B1 经符号链接运行 runner.mjs：照样执行（打出用法），用法里是 node 写法", async () => {
    const link = path.join(tmp, "r.mjs");
    symlinkSync(runnerFile, link);
    const r = await run(process.execPath, [link], { cwd: root });
    assert.ok(r.stdout.includes("用法"), r.stdout);
    assert.ok(r.stdout.includes("node runner.mjs pair <配对码>"), r.stdout);
    assert.equal(isMainModule(link, new URL(`file://${runnerFile}`).href), true);
    assert.equal(isMainModule(path.join(tmp, "nope.mjs"), new URL(`file://${runnerFile}`).href), false);
  });

  it("B2 装好的命令（bin 目录里叫 agent-hub-runner 的链接，直接执行）：用法写 agent-hub-runner", async () => {
    mkdirSync(path.join(tmp, "bin"));
    const link = path.join(tmp, "bin", PKG_BIN);
    symlinkSync(binFile, link);
    const r = await run(link, [], { cwd: tmp });
    assert.ok(r.stdout.includes("agent-hub-runner pair <配对码>@<服务器地址> [--no-start]"), r.stdout);
    assert.ok(r.stdout.includes("agent-hub-runner start"), r.stdout);
    assert.equal(r.stdout.includes("node "), false, r.stdout);
  });

  it("B3 文件在 node_modules 里（Windows 的 .cmd 是直接 node 这个文件）：也写 agent-hub-runner；仓库里跑 bin 写 node 相对路径", async () => {
    const pkg = path.join(tmp, "lib", "node_modules", PKG_BIN);
    mkdirSync(path.join(pkg, "bin"), { recursive: true });
    for (const f of ["runner.mjs", "ops.mjs", "edit.mjs", "changes.mjs", "autostart.mjs", "package.json"]) cpSync(path.join(root, f), path.join(pkg, f));
    cpSync(binFile, path.join(pkg, "bin", "agent-hub-runner.mjs"));
    const r = await run(process.execPath, [path.join(pkg, "bin", "agent-hub-runner.mjs")], { cwd: tmp });
    assert.ok(r.stdout.includes("agent-hub-runner pair <配对码>"), r.stdout);
    assert.equal(progName(path.join(pkg, "bin", "agent-hub-runner.mjs"), tmp), PKG_BIN);
    assert.equal(progName(binFile, root), "node bin/agent-hub-runner.mjs");
    const r2 = await run(process.execPath, [binFile], { cwd: root });
    assert.ok(r2.stdout.includes("node bin/agent-hub-runner.mjs pair <配对码>"), r2.stdout);
  });

  it("B4 装好的命令 pair 不带 --start：「现在运行：agent-hub-runner start」；配置里存了 --server 给的地址（去掉末尾 /）", async () => {
    const srv = createServer((req, res) => {
      let b = ""; req.on("data", (d) => { b += d; });
      req.on("end", () => { res.writeHead(201, { "content-type": "application/json" }); res.end(JSON.stringify({ device_id: "dev-b4", token: "t".repeat(40) })); });
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    try {
      const server = `http://127.0.0.1:${srv.address().port}`;
      const file = path.join(tmp, "cfg-b4", "config.json");
      const link = path.join(tmp, "bin", PKG_BIN);
      const r = await run(link, ["pair", "CODEB4", "--no-start", "--server", `${server}/`], { cwd: tmp, env: { ...process.env, AGENT_RUNNER_CONFIG: file } });
      assert.ok(r.stdout.includes("现在运行：agent-hub-runner start"), r.stdout);
      assert.equal(JSON.parse(readFileSync(file, "utf8")).server, server);
    } finally { srv.close(); }
  });

  it("B5 package.json：可发布（不是 private）、名字和命令都是 agent-hub-runner、只带三份源码 + bin + README、Node 22+", () => {
    const p = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    assert.equal(p.private, undefined);
    assert.equal(p.name, PKG_BIN);
    assert.equal(p.version, "0.1.3");
    assert.equal(p.type, "module");
    assert.deepEqual(p.bin, { [PKG_BIN]: "bin/agent-hub-runner.mjs" });
    assert.deepEqual([...p.files].sort(), ["README.md", "autostart.mjs", "bin/agent-hub-runner.mjs", "changes.mjs", "edit.mjs", "ops.mjs", "runner.mjs"]);
    assert.equal(p.engines.node, ">=22");
    assert.equal(p.dependencies, undefined);
  });
});
