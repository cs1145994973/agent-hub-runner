import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { browserStatus, createBrowserManager, recordingsDirFor } from "../browser.mjs";
import { createCdpRecorder } from "../browser-recorder.mjs";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "r822-a-"));

describe("R822 A：CDP 录像核心（假 CDP / 假 ffmpeg）", () => {
  it("RA1 截帧逐张确认、按 fps 节流、时间轴编码、重复停止不重复执行", async () => {
    const home = tmp();
    try {
      const output = path.join(home, "out.mp4");
      const listeners = new Map(); const calls = []; const runs = []; let timeline = "";
      const session = {
        on: (name, fn) => listeners.set(name, fn), off: (name) => listeners.delete(name),
        send: async (method, args) => { calls.push([method, args]); return {}; }, detach: async () => {},
      };
      const page = { context: () => ({ newCDPSession: async () => session }), evaluate: async () => {} };
      const run = async (cmd, args) => {
        runs.push(args);
        if (args.some((x) => String(x).endsWith("timeline.ffconcat"))) { timeline = readFileSync(args[args.indexOf("-i") + 1], "utf8"); writeFileSync(output, "fake"); }
        return { code: 0 };
      };
      const rec = createCdpRecorder({ page, output, fps: 2, maxSeconds: 20, run, env: { AGENT_HUB_FFMPEG: "ffmpeg" } });
      await rec.start();
      const emit = (at, text, sessionId) => listeners.get("Page.screencastFrame")({ data: Buffer.from(text).toString("base64"), metadata: { timestamp: at }, sessionId });
      emit(1, "one", 1); emit(1.1, "skip", 2); emit(1.6, "two", 3);
      const saved = await rec.stop();
      assert.equal(saved.path, output); assert.equal(rec.isFinished(), true);
      assert.equal(calls.filter(([m]) => m === "Page.screencastFrameAck").length, 3);
      assert.equal((timeline.match(/duration /g) ?? []).length, 2);
      assert.ok(timeline.includes("duration 0.6"));
      assert.equal(runs.length, 2, "-version 一次、编码一次");
      assert.equal((await rec.stop()).path, output); assert.equal(runs.length, 2);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("RA2 没收到画面会失败并结束；开始时发现 ffmpeg 不可用不遗留录像状态", async () => {
    const output = path.join(tmp(), "none.mp4");
    const session = { on: () => {}, off: () => {}, send: async () => ({}), detach: async () => {} };
    const page = { context: () => ({ newCDPSession: async () => session }), evaluate: async () => {} };
    const rec = createCdpRecorder({ page, output, run: async () => ({ code: 0 }), env: { AGENT_HUB_FFMPEG: "ffmpeg" } });
    await rec.start(); await assert.rejects(rec.stop(), /没有收到任何画面/); assert.equal(rec.isFinished(), true);
    const bad = createCdpRecorder({ page, output, run: async () => { throw new Error("找不到 ffmpeg"); }, env: { AGENT_HUB_FFMPEG: "ffmpeg" } });
    await assert.rejects(bad.start(), /找不到 ffmpeg/);
    rmSync(path.dirname(output), { recursive: true, force: true });
  });
});

const REAL = process.env.R729_BROWSER_HOME;
describe("R822 A：当前浏览器真实录像", { skip: !REAL || !browserStatus({ AGENT_RUNNER_HOME: REAL }).installed ? "没设 R729_BROWSER_HOME" : false }, () => {
  let home; let out; let env; let srv; let base; let m;
  before(async () => {
    home = tmp(); out = path.join(home, "videos"); mkdirSync(out, { recursive: true }); env = { AGENT_RUNNER_HOME: home };
    symlinkSync(path.join(REAL, "browser"), path.join(home, "browser")); symlinkSync(path.join(REAL, "browsers"), path.join(home, "browsers"));
    srv = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<title>录像测试</title><style>#b{width:100px;height:100px;background:#36c;animation:x 1s infinite alternate}@keyframes x{to{transform:translateX(300px);background:#c3c}}</style><div id="b"></div><button onclick="document.body.dataset.clicked='1'">点</button>`);
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r)); base = `http://127.0.0.1:${srv.address().port}`;
    m = createBrowserManager({ env, showWindow: false });
  });
  after(async () => { await m?.closeAll(); srv?.close(); rmSync(home, { recursive: true, force: true }); });

  it("RA10 参数、无录像停止都有大白话", async () => {
    await m.run("bot-r", "open", { url: base });
    await assert.rejects(m.run("bot-r", "record_start", { fps: 0 }), /fps/);
    await assert.rejects(m.run("bot-r", "record_start", { max_seconds: 181 }), /max_seconds/);
    await assert.rejects(m.run("bot-r", "record_start", { path: "relative.mp4" }), /绝对路径/);
    await assert.rejects(m.run("bot-r", "record_stop"), /没有开始录像/);
  });

  it("RA11 真实 MP4、重复开始/停止、录制中禁切页、指针和 look 回归", async () => {
    const output = path.join(out, "real.mp4");
    await m.run("bot-r", "open", { url: base });
    const started = await m.run("bot-r", "record_start", { path: output, fps: 5, max_seconds: 10, show_cursor: true });
    assert.equal(started.path, output);
    await assert.rejects(m.run("bot-r", "record_start"), /正在录像/);
    await assert.rejects(m.run("bot-r", "tab", { index: 0 }), /先 record_stop/);
    assert.equal(await m._contextOf("bot-r").pages()[0].evaluate(() => !!window.__agentHubRecordPointer), true);
    await m.run("bot-r", "hover", { x: 120, y: 120 }); await new Promise((r) => setTimeout(r, 500));
    const saved = await m.run("bot-r", "record_stop");
    assert.equal(saved.path, output); assert.ok(existsSync(output));
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name", "-of", "json", output], { encoding: "utf8" }));
    assert.ok(probe.streams.some((s) => s.codec_type === "video" && s.codec_name === "h264"));
    assert.equal(probe.streams.some((s) => s.codec_type === "audio"), false);
    assert.equal(await m._contextOf("bot-r").pages()[0].evaluate(() => !!window.__agentHubRecordPointer), false);
    assert.equal((await m.run("bot-r", "record_stop")).path, output);
    assert.equal((await m.run("bot-r", "look")).kind, "elements");
  });

  it("RA13 两个 bot 同时录像，输出和状态互不混用", async () => {
    const one = path.join(out, "bot-one.mp4"); const two = path.join(out, "bot-two.mp4");
    await Promise.all([m.run("bot-one", "open", { url: base }), m.run("bot-two", "open", { url: base })]);
    await Promise.all([m.run("bot-one", "record_start", { path: one }), m.run("bot-two", "record_start", { path: two })]);
    await new Promise((r) => setTimeout(r, 500));
    const [a, b] = await Promise.all([m.run("bot-one", "record_stop"), m.run("bot-two", "record_stop")]);
    assert.equal(a.path, one); assert.equal(b.path, two); assert.ok(existsSync(one) && existsSync(two)); assert.notEqual(one, two);
  });

  it("RA12 到时自动完成；默认目录按 bot 隔离；关闭浏览器也会保存", async () => {
    await m.run("bot-r", "open", { url: base });
    const auto = await m.run("bot-r", "record_start", { max_seconds: 1 });
    assert.ok(auto.path.startsWith(recordingsDirFor("bot-r", env)));
    await new Promise((r) => setTimeout(r, 1400));
    assert.ok(existsSync((await m.run("bot-r", "record_stop")).path));
    const output = path.join(out, "close.mp4");
    await m.run("bot-r", "record_start", { path: output, max_seconds: 20 }); await new Promise((r) => setTimeout(r, 600));
    const closed = await m.run("bot-r", "close");
    assert.match(closed.text, /录像已保存/); assert.ok(existsSync(output));
  });
});
