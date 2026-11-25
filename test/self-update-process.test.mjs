// @意图#R841(2026-11-15): 不只测 selfUpdate 底层函数：用真实 WebSocket 入口和真实新旧 CLI 进程验收换装。
// npm 响应与 launchctl 隔离；配置、锁、包副本和 LaunchAgents 全在临时目录，绝不碰正在使用的运行器。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { COPY_FILES } from "../autostart.mjs";
import { RUNNER_VERSION } from "../runner.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runnerFile = path.join(root, "runner.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const unix = process.platform === "darwin" || process.platform === "linux";
let base;
let nextVersion;
let tarball;
let integrity;

async function until(fn, message, ms = 20000) {
  for (let t = 0; t < ms; t += 50) { if (fn()) return; await sleep(50); }
  throw new Error(message);
}

/** 最小 masked 文本帧解析，足够覆盖 hello / ready / self_update_result。 */
function onClientJson(c, fn) {
  c.sock.on("data", (buf) => {
    if ((buf[0] & 0x0f) !== 1) return;
    let n = buf[1] & 0x7f; let off = 2;
    if (n === 126) { n = buf.readUInt16BE(2); off = 4; }
    if (n === 127) return;
    const masked = (buf[1] & 0x80) !== 0;
    const mask = masked ? buf.subarray(off, off + 4) : null;
    if (masked) off += 4;
    const data = Buffer.from(buf.subarray(off, off + n));
    if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
    try { fn(JSON.parse(data.toString("utf8"))); } catch { /* 非本测试文本 */ }
  });
}

function wsServer(onConn) {
  const srv = createServer((req, res) => { res.writeHead(404); res.end(); });
  const conns = [];
  srv.on("upgrade", (req, sock) => {
    const acc = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acc}\r\n\r\n`);
    const c = { sock, text: (t) => { const b = Buffer.from(t); sock.write(Buffer.concat([Buffer.from([0x81, b.length]), b])); } };
    sock.on("error", () => {});
    conns.push(c); onConn(c);
  });
  return { srv, conns, listen: () => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${srv.address().port}`))) };
}

async function runUpdate(autostart) {
  const name = autostart ? "auto" : "front";
  const home = path.join(base, name, "home");
  const file = path.join(base, name, "cfg", "config.json");
  mkdirSync(path.dirname(file), { recursive: true });
  const events = [];
  const output = [];
  let oldConn;
  const w = wsServer((c) => onClientJson(c, (m) => {
    if (m.type === "hello") {
      events.push({ type: "hello", version: m.runner_version, autostart: m.autostart });
      if (m.runner_version === RUNNER_VERSION) oldConn = c;
      c.text(JSON.stringify({ type: "ready" }));
    } else if (m.type === "self_update_result") events.push(m);
  }));
  const server = await w.listen();
  writeFileSync(file, JSON.stringify({ server, device_id: `dev-r841-${name}`, token: "fake", bot_dirs: {} }));
  const env = {
    ...process.env,
    AGENT_RUNNER_HOME: home,
    AGENT_RUNNER_CONFIG: file,
    AGENT_RUNNER_LAUNCHD: autostart ? "1" : "",
    AGENT_RUNNER_LAUNCH_AGENTS: path.join(base, name, "LaunchAgents"),
    AGENT_RUNNER_LAUNCHCTL: path.join(base, "fake-launchctl.mjs"),
    FAKE_UPDATE_TARBALL: tarball,
    FAKE_UPDATE_VERSION: nextVersion,
    FAKE_UPDATE_INTEGRITY: integrity,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(path.join(base, "mock-fetch.mjs")).href}`,
  };
  const old = spawn(process.execPath, [runnerFile, "start"], { env, stdio: ["ignore", "pipe", "pipe"] });
  old.stdout.on("data", (b) => output.push(String(b)));
  old.stderr.on("data", (b) => output.push(String(b)));
  let newPid = null;
  try {
    await until(() => oldConn, `旧版 ${RUNNER_VERSION} 没连上假 Hub`);
    oldConn.text(JSON.stringify({ type: "self_update" }));
    await until(() => events.some((m) => m.type === "hello" && m.version === nextVersion), `新版 ${nextVersion} 没回连；旧输出：${output.join("")}`);
    await until(() => old.exitCode !== null || old.signalCode !== null, "旧 CLI 没有退出");
    const lock = JSON.parse(readFileSync(`${file}.lock`, "utf8"));
    newPid = lock.pid;
    assert.equal(lock.version, nextVersion);
    assert.equal(lock.launchd, autostart);
    assert.equal(readlinkSync(path.join(home, "bin", "current")), nextVersion);
    assert.equal(events.find((m) => m.type === "hello" && m.version === nextVersion)?.autostart, autostart);
    for (const m of events.filter((x) => x.type === "self_update_result")) assert.equal(m.ok, true, JSON.stringify(m));
    if (autostart) assert.ok(existsSync(path.join(base, name, "LaunchAgents")));
    return { from: RUNNER_VERSION, to: nextVersion, oldExit: old.exitCode, lock, results: events.filter((m) => m.type === "self_update_result") };
  } finally {
    if (old.exitCode === null && old.signalCode === null) old.kill("SIGTERM");
    if (newPid) { try { process.kill(newPid, "SIGTERM"); } catch { /* 已退出 */ } }
    for (const c of w.conns) c.sock.destroy();
    if (w.srv.listening) w.srv.close();
  }
}

describe("R841 网页自升级真实新旧进程交接", () => {
  before(() => {
    base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "r841-update-")));
    const parts = RUNNER_VERSION.split(".").map(Number);
    nextVersion = `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
    const pkgDir = path.join(base, "fake", "package");
    mkdirSync(pkgDir, { recursive: true });
    for (const f of COPY_FILES) copyFileSync(path.join(root, f), path.join(pkgDir, f));
    const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
    pkg.version = nextVersion;
    writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify(pkg, null, 2));
    tarball = path.join(base, "next.tgz");
    execFileSync("tar", ["-czf", tarball, "package"], { cwd: path.join(base, "fake") });
    integrity = `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;
    writeFileSync(path.join(base, "mock-fetch.mjs"), `
      import { readFileSync } from "node:fs";
      const realFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const url = String(input);
        const version = process.env.FAKE_UPDATE_VERSION;
        const latest = "https://registry.npmjs.org/agent-hub-runner/latest";
        const pack = "https://registry.npmjs.org/agent-hub-runner/-/agent-hub-runner-" + version + ".tgz";
        if (url === latest) return Response.json({ version, dist: { integrity: process.env.FAKE_UPDATE_INTEGRITY, tarball: pack } });
        if (url === pack) return new Response(readFileSync(process.env.FAKE_UPDATE_TARBALL));
        return realFetch(input, init);
      };
    `);
    const launchctl = path.join(base, "fake-launchctl.mjs");
    writeFileSync(launchctl, `#!/usr/bin/env node
      import { spawn } from "node:child_process";
      import { existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
      import path from "node:path";
      import { fileURLToPath } from "node:url";
      const base = path.dirname(fileURLToPath(import.meta.url));
      const action = process.argv[2];
      const pidFile = path.join(base, "fake-launchd.pid");
      if (action === "bootout" && existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, "utf8"));
        if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid, "SIGTERM"); } catch {} }
      } else if (action === "bootstrap") {
        const script = path.join(process.env.AGENT_RUNNER_HOME, "bin", "current", "runner.mjs");
        const log = openSync(path.join(base, "fake-launchd-runner.log"), "a");
        const child = spawn(process.execPath, [script, "start"], { detached: true, env: { ...process.env, AGENT_RUNNER_LAUNCHD: "1" }, stdio: ["ignore", log, log] });
        child.unref(); writeFileSync(pidFile, String(child.pid));
      }
    `);
    chmodSync(launchctl, 0o700);
  });
  after(() => { rmSync(base, { recursive: true, force: true }); });

  it("U8 前台：真实 WebSocket 指令让下一版 CLI 拿锁回连，旧 CLI 退出", { skip: !unix, timeout: 30000 }, async () => {
    const r = await runUpdate(false);
    assert.equal(r.from, RUNNER_VERSION);
    assert.equal(r.to, nextVersion);
    assert.equal(r.lock.launchd, false);
  });

  it("U9 自启：独立新版执行 autostart on，真实新旧 CLI 交接；不碰真实 launchd", { skip: process.platform !== "darwin", timeout: 30000 }, async () => {
    const r = await runUpdate(true);
    assert.equal(r.from, RUNNER_VERSION);
    assert.equal(r.to, nextVersion);
    assert.equal(r.lock.launchd, true);
  });
});
