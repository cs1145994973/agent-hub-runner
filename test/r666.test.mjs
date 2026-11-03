// @意图#R666(2026-10-29): 更傻瓜的安装配对（king 同意 R666）：码@服务器 拆开、报错大白话（连不上的各种原因、配对码各种错、权限、配置坏了、Node 太低）、
// npx 识别（用法写 npx 写法）、退出码（4401/4403/4409 都是 0，4409 不重连，4403 顺手关自启）、同一份配置只能跑一个（锁）、stop、
// Mac 开机自启（plist 生成、复制自己、current 软链、标签后缀、关闭、状态）——全部在临时目录里，launchctl 换成假的，不真加载。
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { autostartOff, autostartOn, autostartStatus, configTag, installCopy, LABEL, labelFor, logFileFor, ONLY_MAC, pickNode, plistPathFor, plistXml, truncateLogIfBig } from "../autostart.mjs";
import {
  decideAutostart, explainError, explainNetError, explainPairFailure, isNpx, loadConfig, main, NO_DIR, nodeTooOld, NPX_CMD, PAIR_ERR, pair,
  parsePairTarget, progName, readLock, RUNNER_VERSION, takeLock,
} from "../runner.mjs";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const runnerFile = path.join(root, "runner.mjs");
const binFile = path.join(root, "bin", "agent-hub-runner.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 最小的 WebSocket 服务器（不用第三方包）：握手后交给 onConn，可以发文字帧、用某个关闭码关掉 */
function wsServer(onConn) {
  const srv = createServer((req, res) => { res.writeHead(404); res.end(); });
  const conns = [];
  srv.on("upgrade", (req, sock) => {
    const acc = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acc}\r\n\r\n`);
    const c = {
      sock,
      text: (t) => { const b = Buffer.from(t); sock.write(Buffer.concat([Buffer.from([0x81, b.length]), b])); },
      close: (code) => { const b = Buffer.alloc(4); b[0] = 0x88; b[1] = 2; b.writeUInt16BE(code, 2); sock.write(b); setTimeout(() => sock.destroy(), 100); },
    };
    sock.on("error", () => {});
    conns.push(c);
    onConn(c);
  });
  return { srv, conns, listen: () => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${srv.address().port}`))) };
}

describe("R666 更傻瓜的安装配对", () => {
  let tmp, fakeLaunchctl, fakeLog;
  const envFor = (name, extra = {}) => ({
    ...process.env, npm_lifecycle_event: "", AGENT_RUNNER_HOME: path.join(tmp, name, "home"), AGENT_RUNNER_CONFIG: path.join(tmp, name, "cfg", "config.json"),
    AGENT_RUNNER_LAUNCH_AGENTS: path.join(tmp, name, "LaunchAgents"), AGENT_RUNNER_LAUNCHCTL: fakeLaunchctl, FAKE_LAUNCHCTL_LOG: fakeLog, ...extra,
  });
  before(() => {
    tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "r666-")));
    fakeLog = path.join(tmp, "launchctl.log");
    fakeLaunchctl = path.join(tmp, "fake-launchctl.sh");
    writeFileSync(fakeLaunchctl, `#!/bin/sh\necho "$@" >> "$FAKE_LAUNCHCTL_LOG"\nexit 0\n`);
    chmodSync(fakeLaunchctl, 0o755);
  });
  after(() => rmSync(tmp, { recursive: true, force: true }));

  it("R1 码@服务器：默认 https，localhost/127.x/[::1] 用 http，可以写 http://、带端口和路径，去掉末尾 /；--server 优先；没 @ 用默认；看不懂的地址报错", () => {
    assert.deepEqual(parsePairTarget("ABCD2345@agenthub-test.qwqcc.com"), { code: "ABCD2345", server: "https://agenthub-test.qwqcc.com" });
    assert.deepEqual(parsePairTarget("ABCD2345@hub.example.com:8443/hub/"), { code: "ABCD2345", server: "https://hub.example.com:8443/hub" });
    assert.deepEqual(parsePairTarget("ABCD2345@127.0.0.1:3240"), { code: "ABCD2345", server: "http://127.0.0.1:3240" });
    assert.deepEqual(parsePairTarget("ABCD2345@localhost:5184"), { code: "ABCD2345", server: "http://localhost:5184" });
    assert.deepEqual(parsePairTarget("ABCD2345@[::1]:3220"), { code: "ABCD2345", server: "http://[::1]:3220" });
    assert.deepEqual(parsePairTarget("ABCD2345@http://192.168.1.5:3220/"), { code: "ABCD2345", server: "http://192.168.1.5:3220" });
    assert.deepEqual(parsePairTarget("ABCD2345@https://127.0.0.1:3240"), { code: "ABCD2345", server: "https://127.0.0.1:3240" });
    assert.deepEqual(parsePairTarget("ABCD2345@hub.example.com", "http://other:1/"), { code: "ABCD2345", server: "http://other:1" });
    assert.deepEqual(parsePairTarget("ABCD2345", "http://127.0.0.1:3220/"), { code: "ABCD2345", server: "http://127.0.0.1:3220" });
    assert.deepEqual(parsePairTarget("ABCD2345"), { code: "ABCD2345", server: "http://127.0.0.1:3220" });
    assert.equal(parsePairTarget("@hub.example.com").code, "");
    assert.throws(() => parsePairTarget("ABCD2345@hub.example.com/?x=1"), /不能带/);
    assert.throws(() => parsePairTarget("ABCD2345@http://"), /看不懂/);
  });

  it("R2 连不上翻成大白话：找不到（ENOTFOUND/EAI_AGAIN）、没开（ECONNREFUSED）、证书、超时、被断开、其他；真的连一个没开的端口和一个不回话的服务器", async () => {
    const S = "https://hub.example.com";
    const fe = (code) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("x"), { code }) });
    assert.match(explainNetError(fe("ENOTFOUND"), S), /找不到服务器 hub\.example\.com.*@ 后面的地址/);
    assert.match(explainNetError(fe("EAI_AGAIN"), S), /找不到服务器/);
    assert.match(explainNetError(fe("ECONNREFUSED"), S), /连不上服务器 https:\/\/hub\.example\.com：服务器没开/);
    assert.match(explainNetError(fe("CERT_HAS_EXPIRED"), S), /https 证书有问题（CERT_HAS_EXPIRED）/);
    assert.match(explainNetError(fe("UNABLE_TO_VERIFY_LEAF_SIGNATURE"), S), /证书有问题/);
    assert.match(explainNetError(fe("ERR_TLS_CERT_ALTNAME_INVALID"), S), /证书有问题/);
    assert.match(explainNetError(Object.assign(new Error("t"), { name: "TimeoutError" }), S), /超时（15 秒没回应）/);
    assert.match(explainNetError(fe("ECONNRESET"), S), /被断开/);
    assert.match(explainNetError(fe("EWHAT"), S), /连不上服务器.*EWHAT/);
    // 真的：没开的端口
    const s = createServer(); await new Promise((r) => s.listen(0, "127.0.0.1", r)); const port = s.address().port; await new Promise((r) => s.close(r));
    await assert.rejects(pair({ code: `CODE@127.0.0.1:${port}`, name: "m" }, path.join(tmp, "r2.json")), /连不上服务器 http:\/\/127\.0\.0\.1:\d+：服务器没开/);
    // 真的：不回话 → 超时（调短）
    const hang = createServer(() => {}); await new Promise((r) => hang.listen(0, "127.0.0.1", r));
    try {
      await assert.rejects(pair({ code: `CODE@127.0.0.1:${hang.address().port}`, name: "m", timeoutMs: 300 }, path.join(tmp, "r2b.json")), /连服务器超时/);
    } finally { hang.closeAllConnections?.(); await new Promise((r) => hang.close(r)); }
    assert.equal(existsSync(path.join(tmp, "r2.json")), false);
  });

  it("R3 配对失败翻成大白话：先看服务器给的 code，老服务器按 400/410/409 猜；404/405/不是 JSON 说「不是 agent-hub 服务器」；5xx；真的配一个回网页的服务器", async () => {
    for (const k of ["bad_code", "used", "replaced", "expired", "device_exists", "bad_input"]) assert.equal(explainPairFailure(400, { code: k, error: "x" }), `配对失败：${PAIR_ERR[k]}`);
    assert.match(explainPairFailure(410, { error: "配对码过期了" }), /过期了（5 分钟有效）.*换一个码/);
    assert.match(explainPairFailure(409, { error: "已经连着" }), /已经连着一台电脑了.*断开/);
    assert.match(explainPairFailure(400, { error: "配对码不对或已经用过了" }), /配对码不对：请从网页上原样复制/);
    assert.match(explainPairFailure(404, { message: "Route not found" }), /不是 agent-hub 服务器（回了 404）/);
    assert.match(explainPairFailure(405, null), /不是 agent-hub 服务器（回了 405）/);
    assert.match(explainPairFailure(200, null), /不是 agent-hub 服务器/);
    assert.match(explainPairFailure(502, null), /服务器出错了（502）/);
    const srv = createServer((req, res) => { res.writeHead(405, { "content-type": "text/html" }); res.end("<html>nope</html>"); });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    try {
      await assert.rejects(pair({ code: `CODE@127.0.0.1:${srv.address().port}`, name: "m" }, path.join(tmp, "r3.json")), /不是 agent-hub 服务器（回了 405）/);
    } finally { srv.close(); }
  });

  it("R4 权限不够说别用 sudo + chown；配置坏了说删掉重配；没配对说去网页「我的电脑」那一行；Node 太低说英文警告不用管、去 nodejs.org；NO_DIR 不再说右栏", () => {
    const e = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES", path: "/Users/x/.agent-runner/config.json" });
    assert.match(explainError(e), /权限不够，写不了 \/Users\/x\/\.agent-runner\/config\.json：别用 sudo.*sudo chown -R "\$\(whoami\)" "\/Users\/x\/\.agent-runner"/);
    assert.match(explainError(Object.assign(new Error("p"), { code: "EPERM", path: "/x/y/z.json" })), /权限不够.*chown -R "\$\(whoami\)" "\/x\/y"/);
    assert.equal(explainError(new Error("别的")), "别的");
    const bad = path.join(tmp, "bad.json"); writeFileSync(bad, "{坏了");
    assert.throws(() => loadConfig(bad), /配置文件坏了：.*bad\.json。删掉它（rm ".*bad\.json"），再回网页拿新配对码重新配对/);
    assert.throws(() => loadConfig(path.join(tmp, "none.json")), /还没配对.*输入框下面「我的电脑」那一行/);
    assert.equal(loadConfig.toString().includes("连接电脑"), false);
    assert.match(nodeTooOld("18.20.8"), /需要 Node 22 或更新，你这台电脑上是 18\.20\.8.*EBADENGINE.*不用管.*nodejs\.org/s);
    assert.equal(NO_DIR.includes("右栏"), false);
    assert.ok(NO_DIR.includes("输入框下面「我的电脑」那一行"));
  });

  it("R5 npx 识别：npm_lifecycle_event=npx 或文件在 _npx 缓存里 → npx -y agent-hub-runner@latest；开机自启的副本（~/.agent-runner/bin 下）也是；仓库里照旧 node 写法", async () => {
    assert.equal(NPX_CMD, "npx -y agent-hub-runner@latest");
    const env = { AGENT_RUNNER_HOME: path.join(tmp, "r5home") };
    assert.equal(progName(binFile, root, { ...env, npm_lifecycle_event: "npx" }), NPX_CMD);
    assert.equal(isNpx("/Users/x/.npm/_npx/8c866599b4fa2097/node_modules/.bin/agent-hub-runner", {}), true);
    assert.equal(progName("/Users/x/.npm/_npx/8c866599b4fa2097/node_modules/.bin/agent-hub-runner", root, env), NPX_CMD);
    assert.equal(progName(path.join(env.AGENT_RUNNER_HOME, "bin", "current", "runner.mjs"), root, env), NPX_CMD);
    assert.equal(progName(binFile, root, env), "node bin/agent-hub-runner.mjs");
    assert.equal(progName("/usr/local/bin/agent-hub-runner", root, env), "agent-hub-runner");
    // 真跑：npm 设的环境变量在，用法里就是 npx 写法
    const r = await run(process.execPath, [binFile], { cwd: root, env: { ...process.env, npm_lifecycle_event: "npx" } });
    assert.ok(r.stdout.includes(`${NPX_CMD} pair <配对码>@<服务器地址>`), r.stdout);
    assert.ok(r.stdout.includes(`${NPX_CMD} autostart on|off|status`), r.stdout);
  });

  it("R6 锁：别的活着的进程拿着就拿不到（带进程号）；进程死了的旧锁直接覆盖；release 只删自己的；start 时后台已在跑：提示「已经在后台连着，不用再开」退出 0", async () => {
    const file = path.join(tmp, "r6", "config.json");
    const other = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"]);
    try {
      const l1 = takeLock(file, { pid: other.pid, launchd: true });
      assert.equal(l1.ok, true);
      assert.equal(statSync(`${file}.lock`).mode & 0o777, 0o600);
      const l2 = takeLock(file);
      assert.deepEqual(l2, { ok: false, pid: other.pid, launchd: true });
      // start 命令：拿不到锁就提示、退出 0
      writeFileSync(file, JSON.stringify({ server: "http://127.0.0.1:9", device_id: "d", token: "t", bot_dirs: {} }));
      const r = await run(process.execPath, [runnerFile, "start"], { env: { ...process.env, AGENT_RUNNER_CONFIG: file } });
      assert.ok(r.stdout.includes(`已经在后台连着，不用再开（进程 ${other.pid}，开机自启起的）`), r.stdout);
      // stop：停掉拿着锁的那个
      const s = await run(process.execPath, [runnerFile, "stop"], { env: { ...process.env, AGENT_RUNNER_CONFIG: file } });
      assert.ok(s.stdout.includes(`已停掉（进程 ${other.pid}）`), s.stdout);
      await sleep(100);
      assert.notEqual(other.exitCode ?? other.signalCode, null);
      const l3 = takeLock(file); // 那个进程死了：旧锁覆盖
      assert.equal(l3.ok, true);
      assert.equal(readLock(file).pid, process.pid);
      l3.release();
      assert.equal(existsSync(`${file}.lock`), false);
      const s2 = await run(process.execPath, [runnerFile, "stop"], { env: { ...process.env, AGENT_RUNNER_CONFIG: file } });
      assert.ok(s2.stdout.includes("没有在跑的运行器"), s2.stdout);
    } finally { other.kill(); }
  });

  for (const [code, why, re] of [[4401, "bad_token", /服务器不认这个令牌/], [4403, "revoked", /这台电脑已在网页上断开/], [4409, "replaced", /顶掉了：这个先退出（不再重连）/]]) {
    it(`R7 关闭码 ${code}（${why}）：不再重连、退出码 0、释放锁${code !== 4409 ? "；开着自启的顺手关掉（删 plist + bootout）" : "；自启不动"}`, async () => {
      const w = wsServer((c) => { c.sock.once("data", () => c.close(code)); }); // 收到 hello 就关
      const server = await w.listen();
      try {
        const name = `r7-${code}`;
        const env = envFor(name);
        mkdirSync(path.dirname(env.AGENT_RUNNER_CONFIG), { recursive: true });
        writeFileSync(env.AGENT_RUNNER_CONFIG, JSON.stringify({ server, device_id: "dev-x", token: "tok", bot_dirs: {} }));
        const plist = plistPathFor(env.AGENT_RUNNER_CONFIG, env);
        mkdirSync(path.dirname(plist), { recursive: true });
        writeFileSync(plist, "<plist/>");
        const t0 = Date.now();
        const ch = spawn(process.execPath, [runnerFile, "start"], { env });
        let out = ""; ch.stdout.on("data", (d) => { out += d; }); ch.stderr.on("data", (d) => { out += d; });
        const exit = await new Promise((r) => ch.on("exit", r));
        assert.equal(exit, 0, out);
        assert.match(out, re);
        assert.ok(Date.now() - t0 < 4000);
        await sleep(2500); // 默认 2 秒后重连：不该再来
        assert.equal(w.conns.length, 1, "只连了一次，没重连");
        assert.equal(existsSync(`${env.AGENT_RUNNER_CONFIG}.lock`), false);
        if (code !== 4409 && process.platform === "darwin") {
          assert.equal(existsSync(plist), false, "4401/4403：自启的 plist 删了");
          assert.match(readFileSync(fakeLog, "utf8"), new RegExp(`bootout gui/\\d+/${labelFor(env.AGENT_RUNNER_CONFIG, env).replace(/\./g, "\\.")}`));
          assert.ok(out.includes("已关掉开机自启"), out);
        } else {
          assert.equal(existsSync(plist), true, "4409（或不是 Mac）：plist 不动");
        }
      } finally { w.srv.close(); }
    });
  }

  it("R8 hello 带 runner_version 和 autostart（AGENT_RUNNER_LAUNCHD=1 时是 true，连上那句不说 Ctrl-C）", async () => {
    let hello;
    const w = wsServer((c) => {
      c.sock.on("data", (buf) => {
        if (hello || (buf[0] & 0x0f) !== 1) return;
        const len = buf[1] & 0x7f; let off = 2; let n = len;
        if (len === 126) { n = buf.readUInt16BE(2); off = 4; }
        const mask = buf.subarray(off, off + 4); const data = Buffer.from(buf.subarray(off + 4, off + 4 + n)).map((b, i) => b ^ mask[i % 4]);
        hello = JSON.parse(Buffer.from(data).toString("utf8"));
        c.text(JSON.stringify({ type: "ready" }));
        setTimeout(() => c.close(4409), 200);
      });
    });
    const server = await w.listen();
    try {
      const env = envFor("r8", { AGENT_RUNNER_LAUNCHD: "1" });
      mkdirSync(path.dirname(env.AGENT_RUNNER_CONFIG), { recursive: true });
      writeFileSync(env.AGENT_RUNNER_CONFIG, JSON.stringify({ server, device_id: "dev-8", token: "tok", bot_dirs: {} }));
      const r = await run(process.execPath, [runnerFile, "start"], { env });
      assert.equal(hello.runner_version, RUNNER_VERSION);
      assert.equal(hello.autostart, true);
      assert.ok(r.stdout.includes("（开机自启，在后台运行）"), r.stdout);
      assert.equal(r.stdout.includes("Ctrl-C"), false, r.stdout);
      // 开机自启时配置坏了：说清楚、退出 0（不让 launchd 反复拉起）
      writeFileSync(env.AGENT_RUNNER_CONFIG, "{坏");
      const r2 = await run(process.execPath, [runnerFile, "start"], { env });
      assert.match(r2.stderr, /配置文件坏了/);
    } finally { w.srv.close(); }
  });

  it("R9 plist：ProgramArguments = [node, ~/.agent-runner/bin/current/runner.mjs, start]、环境变量写明配置绝对路径、RunAtLoad、KeepAlive 只非 0 拉起、ThrottleInterval 10、日志；值会转义", () => {
    const x = plistXml({ label: "com.agenthub.runner", args: ["/opt/homebrew/bin/node", "/Users/a&b/.agent-runner/bin/current/runner.mjs", "start"], env: { AGENT_RUNNER_CONFIG: "/Users/a&b/c.json", AGENT_RUNNER_LAUNCHD: "1" }, log: "/Users/a/l.log" });
    assert.ok(x.includes("<string>com.agenthub.runner</string>"));
    assert.ok(x.includes("<string>/opt/homebrew/bin/node</string>\n      <string>/Users/a&amp;b/.agent-runner/bin/current/runner.mjs</string>\n      <string>start</string>"));
    assert.ok(x.includes("<key>AGENT_RUNNER_CONFIG</key>\n      <string>/Users/a&amp;b/c.json</string>"));
    assert.match(x, /<key>RunAtLoad<\/key>\s*<true\/>/);
    assert.match(x, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/);
    assert.match(x, /<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);
    assert.match(x, /<key>StandardOutPath<\/key>\s*<string>\/Users\/a\/l\.log<\/string>/);
    assert.match(x, /<key>StandardErrorPath<\/key>\s*<string>\/Users\/a\/l\.log<\/string>/);
  });

  it("R10 autostart on（假 launchctl、临时目录）：复制自己到 bin/<版本>/ + current 软链、写 plist、先 bootout 再 bootstrap；非默认配置标签加 sha8 后缀，默认配置就是 com.agenthub.runner；off 删 plist + bootout；status 认出进程号和缺的 node；不是 Mac 报只支持 Mac", async () => {
    const env = envFor("r10");
    const home = env.AGENT_RUNNER_HOME;
    mkdirSync(path.dirname(env.AGENT_RUNNER_CONFIG), { recursive: true });
    writeFileSync(env.AGENT_RUNNER_CONFIG, "{}");
    const calls = [];
    const launchctl = async (a) => { calls.push(a.join(" ")); return a[0] === "print" ? { code: 0, stdout: "state = running\n\tpid = 4242\n", stderr: "" } : { code: 0, stdout: "", stderr: "" }; };
    await assert.rejects(autostartOn({ configFile: env.AGENT_RUNNER_CONFIG, version: "9.9.9", srcDir: root, env, launchctl, platform: "linux" }), new RegExp(ONLY_MAC));
    const r = await autostartOn({ configFile: env.AGENT_RUNNER_CONFIG, version: "9.9.9", srcDir: root, execPath: process.execPath, env, launchctl, platform: "darwin" });
    const tag = createHash("sha256").update(env.AGENT_RUNNER_CONFIG).digest("hex").slice(0, 8);
    assert.equal(configTag(env.AGENT_RUNNER_CONFIG, env), tag);
    assert.equal(r.label, `${LABEL}.${tag}`);
    assert.equal(labelFor(path.join(home, "config.json"), env), LABEL);
    assert.equal(logFileFor(path.join(home, "config.json"), env), path.join(home, "logs", "runner.log"));
    assert.equal(r.log, path.join(home, "logs", `runner-${tag}.log`));
    assert.equal(r.script, path.join(home, "bin", "current", "runner.mjs"));
    assert.equal(readlinkSync(path.join(home, "bin", "current")), "9.9.9");
    assert.ok(lstatSync(path.join(home, "bin", "current")).isSymbolicLink());
    for (const f of ["runner.mjs", "ops.mjs", "edit.mjs", "changes.mjs", "autostart.mjs", "package.json"]) assert.ok(existsSync(path.join(home, "bin", "9.9.9", f)), f);
    assert.equal(r.node, pickNode(process.execPath));
    const xml = readFileSync(r.plist, "utf8");
    assert.equal(r.plist, path.join(env.AGENT_RUNNER_LAUNCH_AGENTS, `${LABEL}.${tag}.plist`));
    assert.ok(xml.includes(`<string>${r.node}</string>\n      <string>${r.script}</string>\n      <string>start</string>`));
    assert.ok(xml.includes(`<key>AGENT_RUNNER_CONFIG</key>\n      <string>${env.AGENT_RUNNER_CONFIG}</string>`));
    assert.ok(xml.includes("<key>AGENT_RUNNER_LAUNCHD</key>\n      <string>1</string>"));
    assert.ok(xml.includes("<key>PATH</key>"));
    const uid = process.getuid();
    assert.deepEqual(calls, [`bootout gui/${uid}/${r.label}`, `bootstrap gui/${uid} ${r.plist}`]);
    // 副本能直接跑（开机不联网也能起来：不依赖 npx 缓存）
    const v = await run(process.execPath, [r.script, "--version"], { env });
    assert.equal(v.stdout.trim(), RUNNER_VERSION);
    // 再开一次（升级）：current 换到新版本
    await autostartOn({ configFile: env.AGENT_RUNNER_CONFIG, version: "9.9.10", srcDir: root, env, launchctl, platform: "darwin" });
    assert.equal(readlinkSync(path.join(home, "bin", "current")), "9.9.10");
    const st = await autostartStatus({ configFile: env.AGENT_RUNNER_CONFIG, env, launchctl, platform: "darwin" });
    assert.equal(st.installed, true); assert.equal(st.loaded, true); assert.equal(st.pid, 4242); assert.deepEqual(st.problems, []);
    writeFileSync(r.plist, xml.replace(r.node, "/nope/node"));
    assert.match((await autostartStatus({ configFile: env.AGENT_RUNNER_CONFIG, env, launchctl, platform: "darwin" })).problems.join(), /找不到 node：\/nope\/node/);
    calls.length = 0;
    assert.deepEqual(await autostartOff({ configFile: env.AGENT_RUNNER_CONFIG, env, launchctl }), { wasOn: true });
    assert.equal(existsSync(r.plist), false);
    assert.deepEqual(calls, [`bootout gui/${uid}/${r.label}`]);
    assert.deepEqual(await autostartOff({ configFile: env.AGENT_RUNNER_CONFIG, env, launchctl }), { wasOn: false });
    // bootstrap 失败：报清楚
    await assert.rejects(autostartOn({ configFile: env.AGENT_RUNNER_CONFIG, version: "9.9.10", srcDir: root, env, platform: "darwin", launchctl: async (a) => (a[0] === "bootstrap" ? { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" } : { code: 0, stdout: "", stderr: "" }) }), /开机自启没设成：launchctl bootstrap 失败（Bootstrap failed: 5/);
    assert.equal(installCopy({ srcDir: path.join(home, "bin", "9.9.10"), version: "9.9.10", env }), path.join(home, "bin", "current", "runner.mjs")); // 从副本自己再开：不复制到自己身上
  });

  it("R11 pickNode：稳定软链和当前 node 是同一个文件就用软链，否则原样；日志超 5MB 清空", () => {
    const fake = path.join(tmp, "r11-node");
    writeFileSync(fake, "");
    assert.equal(pickNode(process.execPath, [fake]), process.execPath);
    assert.equal(pickNode(fake, ["/nope/node", fake]), fake);
    const log = path.join(tmp, "r11.log");
    writeFileSync(log, "x".repeat(20));
    assert.equal(truncateLogIfBig(log, 100), false);
    assert.equal(truncateLogIfBig(log, 10), true);
    assert.equal(statSync(log).size, 0);
    assert.equal(truncateLogIfBig(path.join(tmp, "none.log"), 10), false);
  });

  it("R12 要不要开机自启：--autostart / --no-autostart 优先；不是 Mac 不开（--autostart 说只支持 Mac）；Mac 终端里问，不是终端只提示", () => {
    assert.equal(decideAutostart({ flag: true, platform: "darwin", tty: false }), "on");
    assert.equal(decideAutostart({ flag: true, platform: "linux", tty: true }), "unsupported");
    assert.equal(decideAutostart({ flag: false, platform: "darwin", tty: true }), "off");
    assert.equal(decideAutostart({ platform: "darwin", tty: true }), "ask");
    assert.equal(decideAutostart({ platform: "darwin", tty: false }), "hint");
    assert.equal(decideAutostart({ platform: "linux", tty: true }), "off");
  });

  it("R13 pair 码@地址（Mac、终端里答「是」）：配对成功 → 开机自启（假 launchctl），不在前台跑；答「否」+ --no-start：提示以后怎么开、现在运行 start；非终端只提示", async () => {
    const srv = createServer((req, res) => {
      let b = ""; req.on("data", (d) => { b += d; });
      req.on("end", () => { res.writeHead(201, { "content-type": "application/json" }); res.end(JSON.stringify({ device_id: "dev-13", token: "t".repeat(40), got: JSON.parse(b).code })); });
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const keep = { ...process.env };
    const logs = []; const origLog = console.log; console.log = (...a) => { logs.push(a.join(" ")); };
    try {
      const env = envFor("r13");
      Object.assign(process.env, env);
      const calls = [];
      const launchctl = async (a) => { calls.push(a[0]); return { code: 0, stdout: "", stderr: "" }; };
      const asked = [];
      await main(["pair", `CODE13@127.0.0.1:${srv.address().port}`], NPX_CMD, { platform: "darwin", tty: true, ask: async (q) => { asked.push(q); return true; }, launchctl });
      assert.deepEqual(asked, ["开机自动连上？以后不用开终端 (Y/n) "]);
      assert.deepEqual(calls, ["bootout", "bootstrap"]);
      const cfg = JSON.parse(readFileSync(env.AGENT_RUNNER_CONFIG, "utf8"));
      assert.equal(cfg.server, `http://127.0.0.1:${srv.address().port}`);
      const out = logs.join("\n");
      assert.ok(out.includes("已设开机自启"), out);
      assert.ok(out.includes(`关掉开机自启：${NPX_CMD} autostart off`), out);
      assert.equal(out.includes("接着连服务器"), false);
      logs.length = 0;
      await main(["pair", `CODE14@127.0.0.1:${srv.address().port}`, "--no-start"], NPX_CMD, { platform: "darwin", tty: true, ask: async () => false, launchctl });
      assert.ok(logs.join("\n").includes(`好的，不设开机自启。以后想开：${NPX_CMD} autostart on`));
      assert.ok(logs.join("\n").includes(`现在运行：${NPX_CMD} start`));
      logs.length = 0;
      await main(["pair", `CODE15@127.0.0.1:${srv.address().port}`, "--no-start"], NPX_CMD, { platform: "darwin", tty: false, ask: async () => { throw new Error("不该问"); }, launchctl });
      assert.ok(logs.join("\n").includes(`想开机自动连上（不用开终端）：运行 ${NPX_CMD} autostart on`));
      logs.length = 0;
      await main(["pair", `CODE16@127.0.0.1:${srv.address().port}`, "--no-start"], NPX_CMD, { platform: "linux", tty: true, ask: async () => { throw new Error("不该问"); } });
      assert.equal(logs.join("\n").includes("开机"), false);
      // 卸载：关自启、删副本和日志；--purge 连配置一起删
      logs.length = 0;
      await main(["uninstall", "--purge"], NPX_CMD, { platform: "darwin", tty: false, launchctl });
      assert.equal(existsSync(path.join(env.AGENT_RUNNER_HOME, "bin")), false);
      assert.equal(existsSync(env.AGENT_RUNNER_CONFIG), false);
      assert.equal(existsSync(plistPathFor(env.AGENT_RUNNER_CONFIG, env)), false);
      assert.ok(logs.join("\n").includes("记得在网页「我的电脑」里点「断开」"));
    } finally {
      console.log = origLog;
      for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k];
      Object.assign(process.env, keep);
      srv.close();
    }
  });
});
