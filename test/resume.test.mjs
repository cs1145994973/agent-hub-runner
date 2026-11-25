// @意图#R957(2026-11-24): 短断不杀活验收（运行器侧）。证明：断线后命令还活着、重连后输出与结果补齐、
// 宽限到点才杀；停止/吊销/顶掉仍立刻杀。平台无关（用 node 自身当被执行的命令，不依赖 bash）。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { RESUME_GRACE_MS, RESUMABLE_OPS, startRunner } from "../runner.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, message = "等待超时", ms = 8_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await sleep(20); }
  throw new Error(message);
};
const tmp = mkdtempSync(path.join(os.tmpdir(), "r955-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** 最小 WS 服务端：能收长帧（运行器 hello 很大）、发短帧、带 reason 关闭。 */
function wsServer(onConn) {
  const srv = createServer((req, res) => { res.writeHead(404); res.end(); });
  const conns = [];
  srv.on("upgrade", (req, sock) => {
    const acc = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acc}\r\n\r\n`);
    const c = { sock, msgs: [], text: (t) => {
      const b = Buffer.from(t);
      const head = b.length < 126 ? Buffer.from([0x81, b.length])
        : (() => { const h = Buffer.alloc(4); h[0] = 0x81; h[1] = 126; h.writeUInt16BE(b.length, 2); return h; })();
      assert.ok(b.length < 65536, "测试只发 16 位长度帧");
      sock.write(Buffer.concat([head, b]));
    }, close: (code, reason = "") => {
      const r = Buffer.from(reason); const body = Buffer.alloc(2 + r.length);
      body.writeUInt16BE(code, 0); r.copy(body, 2);
      assert.ok(body.length < 126);
      sock.write(Buffer.concat([Buffer.from([0x88, body.length]), body]));
      setTimeout(() => sock.destroy(), 100);
    } };
    // 客户端帧要解掩码；只处理文本帧，够测试用
    let buf = Buffer.alloc(0);
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (buf.length < 2) return;
        const len0 = buf[1] & 0x7f;
        let off = 2, len = len0;
        if (len0 === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len0 === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        const masked = (buf[1] & 0x80) !== 0;
        if (masked) { if (buf.length < off + 4 + len) return; } else if (buf.length < off + len) return;
        let payload = buf.subarray(off + (masked ? 4 : 0), off + (masked ? 4 : 0) + len);
        if (masked) {
          const key = buf.subarray(off, off + 4);
          payload = Buffer.from(payload.map((b, i) => b ^ key[i % 4]));
        }
        buf = buf.subarray(off + (masked ? 4 : 0) + len);
        try { const m = JSON.parse(payload.toString("utf8")); c.msgs.push(m); onConn(c, m); } catch { /* 非文本 */ }
      }
    });
    sock.on("error", () => {});
    conns.push(c);
  });
  return { srv, conns, listen: () => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${srv.address().port}`))) };
}

/** 起一个运行器 + 一个假服务器；dir 里放好可执行脚本用的目录。 */
async function setup(name, onMsg, extra = {}) {
  const dir = path.join(tmp, name, "work");
  mkdirSync(dir, { recursive: true });
  const file = path.join(tmp, name, "config.json");
  const w = wsServer((c, m) => {
    if (m.type === "hello") c.text(JSON.stringify({ type: "ready" }));
    onMsg?.(c, m);
  });
  const server = await w.listen();
  const lines = [];
  const runner = startRunner({ server, device_id: `dev-${name}`, token: "tok", bot_dirs: { "bot-x": dir } },
    { file, log: (s) => lines.push(s), platform: "darwin", retryMs: 30, background: true, ...extra });
  await until(() => w.conns.some((c) => c.msgs.some((m) => m.type === "hello")), "没连上");
  return { w, server, dir, file, lines, runner, cleanup: () => { runner.stop(); for (const c of w.conns) c.sock.destroy(); w.srv.close(); } };
}
/** 让运行器跑一条 node 命令（跨平台，不用 bash）：睡 ms 毫秒后打印一行。 */
const nodeSleep = (ms) => `${JSON.stringify(process.execPath)} -e "setTimeout(()=>console.log('done-${ms}'),${ms})"`;
const callMsg = (id, command) => ({ type: "call", id, op: "bash", bot_id: "bot-x", args: { command, timeout: 30 } });

describe("R957 运行器短断不杀活", () => {
  it("S1 断线后命令继续跑，重连后输出与结果补发（同一 id）", async () => {
    const s = await setup("s1", undefined, { retryMs: 600 }); // 重连比命令完成慢，才能真正测到「断线期间攒着」
    try {
      const c0 = s.w.conns[0];
      c0.text(JSON.stringify(callMsg("call-1", nodeSleep(200))));
      await until(() => s.lines.some((l) => l.includes("bash：")), "没开始执行");
      c0.close(1006, ""); // 链路掉一下
      await until(() => s.lines.some((l) => l.includes("连接断了")), "没记断开");
      await sleep(200);
      assert.ok(!s.lines.some((l) => l.includes("没连回来")), "宽限内不该杀活");
      await until(() => s.w.conns.length >= 2, "没有重连");
      const c1 = s.w.conns[1];
      await until(() => c1.msgs.some((m) => m.type === "result" && m.id === "call-1"), "重连后没补发结果");
      const out = c1.msgs.filter((m) => m.type === "output" && m.id === "call-1");
      const text = Buffer.concat(out.map((m) => Buffer.from(m.data, "base64"))).toString("utf8");
      assert.match(text, /done-200/, "断线期间的输出要补齐");
      const res = c1.msgs.find((m) => m.type === "result" && m.id === "call-1");
      assert.equal(res.ok, true);
      assert.equal(res.exitCode, 0);
      assert.ok(s.lines.some((l) => l.includes("已补发")), "要记一行补发");
      assert.equal(c0.msgs.filter((m) => m.type === "result").length, 0, "旧连接不该收到结果");
    } finally { s.cleanup(); }
  });

  it("S2 宽限到点还没连回来：把还在跑的调用停掉并记一行", async () => {
    const s = await setup("s2", undefined, { resumeGraceMs: 400 });
    try {
      s.w.conns[0].text(JSON.stringify(callMsg("call-2", nodeSleep(5_000))));
      await until(() => s.lines.some((l) => l.includes("bash：")), "没开始执行");
      for (const c of s.w.conns) c.sock.destroy(); // 先断现有连接，否则 srv.close 回调永远不来
      await new Promise((r) => s.w.srv.close(r)); // 再关监听，让重连一直失败
      await until(() => s.lines.some((l) => l.includes("连接断了")), "没记断开");
      await sleep(150);
      assert.ok(!s.lines.some((l) => l.includes("没连回来")), "未到宽限不该杀");
      await until(() => s.lines.some((l) => l.includes("没连回来")), "宽限到点没杀活");
      assert.equal(RESUME_GRACE_MS, 60_000, "默认宽限 60 秒");
    } finally { s.cleanup(); }
  });

  it("S3 被顶掉（4409）立刻杀活、不保活、不重连", async () => {
    const s = await setup("s3");
    try {
      const c0 = s.w.conns[0];
      c0.text(JSON.stringify(callMsg("call-3", nodeSleep(3_000))));
      await until(() => s.lines.some((l) => l.includes("bash：")), "没开始执行");
      c0.close(4409, "replaced");
      assert.equal(await s.runner.done, "replaced");
      await sleep(150);
      assert.equal(s.w.conns.length, 1, "被顶掉不该重连");
      assert.ok(!s.lines.some((l) => l.includes("已补发")), "被顶掉不该补发");
    } finally { s.cleanup(); }
  });

  it("S4 网页上断开（revoked 消息）立刻杀活", async () => {
    const s = await setup("s4");
    try {
      const c0 = s.w.conns[0];
      c0.text(JSON.stringify(callMsg("call-4", nodeSleep(3_000))));
      await until(() => s.lines.some((l) => l.includes("bash：")), "没开始执行");
      c0.text(JSON.stringify({ type: "revoked" }));
      await sleep(120);
      const results = c0.msgs.filter((m) => m.type === "result" && m.id === "call-4");
      assert.ok(results.some((r) => r.ok === false && /中止/.test(r.error ?? "")), "吊销要立刻中止在跑的调用");
    } finally { s.cleanup(); }
  });

  it("S5 hello 报 resume=true；只保名单内的普通工具调用", async () => {
    const s = await setup("s5");
    try {
      const hello = s.w.conns[0].msgs.find((m) => m.type === "hello");
      assert.equal(hello.resume, true);
      for (const op of ["read", "write", "edit", "bash", "powershell", "grep", "find", "ls"]) assert.ok(RESUMABLE_OPS.has(op), op);
      for (const op of ["browser", "search", "file_upload", "pick_dir"]) assert.ok(!RESUMABLE_OPS.has(op), op);
    } finally { s.cleanup(); }
  });
});