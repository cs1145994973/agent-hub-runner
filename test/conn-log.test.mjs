// @意图#R952(2026-11-24): 运行器断开观测验收。只证明日志把原因记清楚（close code / reason / 连接时长 /
// 最后收到消息距今 / 自身卡顿），重连与退出行为和原来一样。平台无关。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { loopLagMonitor, startRunner } from "../runner.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, message = "等待超时") => {
  const end = Date.now() + 5_000;
  while (Date.now() < end) { if (fn()) return; await sleep(20); }
  throw new Error(message);
};
const tmp = mkdtempSync(path.join(os.tmpdir(), "r951-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** 最小 WebSocket 服务端：能发短文本，也能带 reason 关闭（reason 会进运行器日志）。 */
function wsServer(onConn) {
  const srv = createServer((req, res) => { res.writeHead(404); res.end(); });
  const conns = [];
  srv.on("upgrade", (req, sock) => {
    const acc = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acc}\r\n\r\n`);
    const frame = (op, b) => {
      assert.ok(b.length < 126, "测试只发短帧");
      sock.write(Buffer.concat([Buffer.from([0x80 | op, b.length]), b]));
    };
    const c = {
      sock,
      text: (t) => frame(0x1, Buffer.from(t)),
      close: (code, reason = "") => {
        const r = Buffer.from(reason);
        const body = Buffer.alloc(2 + r.length);
        body.writeUInt16BE(code, 0); r.copy(body, 2);
        frame(0x8, body); // 必须原始字节，不能过 utf8（关闭码高位会被改写）
        setTimeout(() => sock.destroy(), 100);
      },
    };
    sock.on("error", () => {});
    conns.push(c);
    onConn(c);
  });
  return { srv, conns, listen: () => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${srv.address().port}`))) };
}

describe("R952 运行器断开原因观测", () => {
  it("K1 服务器按心跳超时断开：日志带 code/reason/连接时长/最后收消息距今/卡顿，并照旧重连", async () => {
    let n = 0;
    const w = wsServer((c) => {
      n += 1;
      c.sock.once("data", () => {
        c.text(JSON.stringify({ type: "ready" }));
        if (n === 1) setTimeout(() => c.close(1001, "heartbeat timeout"), 60);
      });
    });
    const server = await w.listen();
    const file = path.join(tmp, "k1", "config.json");
    mkdirSync(path.dirname(file), { recursive: true });
    const lines = [];
    const runner = startRunner({ server, device_id: "dev-k1", token: "tok", bot_dirs: {} },
      { file, log: (s) => lines.push(s), platform: "darwin", retryMs: 30, background: true });
    try {
      await until(() => lines.some((l) => l.includes("连接断了")), "没有记断开");
      const line = lines.find((l) => l.includes("连接断了"));
      assert.match(line, /code=1001/);
      assert.match(line, /reason=heartbeat timeout/);
      assert.match(line, /upMs=\d+/);
      assert.match(line, /sinceRecvMs=\d+/);
      assert.match(line, /lagMs=\d+/);
      assert.match(line, /lagMaxMs=\d+/);
      assert.match(line, /秒后重连/);
      await until(() => n >= 2, "断开后没有照旧重连"); // 行为不变
      await until(() => lines.filter((l) => l.includes("已连上")).length >= 2, "重连成功没记上线");
    } finally {
      runner.stop();
      for (const c of w.conns) c.sock.destroy();
      w.srv.close();
    }
  });

  it("K2 被顶掉（4409）仍照旧退出、不重连", async () => {
    const w = wsServer((c) => c.sock.once("data", () => c.close(4409, "replaced")));
    const server = await w.listen();
    const file = path.join(tmp, "k2", "config.json");
    mkdirSync(path.dirname(file), { recursive: true });
    const lines = [];
    const runner = startRunner({ server, device_id: "dev-k2", token: "tok", bot_dirs: {} },
      { file, log: (s) => lines.push(s), platform: "darwin", retryMs: 30, background: true });
    try {
      assert.equal(await runner.done, "replaced");
      assert.ok(lines.some((l) => l.includes("顶掉")));
      await sleep(80);
      assert.equal(w.conns.length, 1, "被顶掉不该再连");
    } finally {
      runner.stop();
      for (const c of w.conns) c.sock.destroy();
      w.srv.close();
    }
  });

  it("K3 卡顿监测：同步卡住后立刻报得出；stop 后不再累计", async () => {
    const lag = loopLagMonitor(20);
    await sleep(50);
    const until2 = Date.now() + 150;
    while (Date.now() < until2) { /* 占住事件循环 */ }
    assert.ok(lag.lagMs() >= 100, "卡顿刚结束就要报出来");
    assert.ok(lag.maxMs() >= 100);
    lag.stop();
    const before = lag.maxMs();
    const until3 = Date.now() + 120;
    while (Date.now() < until3) { /* 再卡一次 */ }
    await sleep(40);
    assert.equal(lag.maxMs(), before, "stop 之后不该再累计");
  });
});