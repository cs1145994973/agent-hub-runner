import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { browserStatus, createBrowserManager, PW_VERSION } from "../browser.mjs";
import { withTabRecorder } from "../tab-recorder.mjs";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "r822-b-"));
function fakeInstall(home) {
  const pkg = path.join(home, "browser", "node_modules", "playwright-core"); mkdirSync(pkg, { recursive: true });
  writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "playwright-core", version: PW_VERSION }));
  writeFileSync(path.join(pkg, "browsers.json"), JSON.stringify({ browsers: [{ name: "chromium", revision: "9999" }] }));
  mkdirSync(path.join(home, "browsers", "chromium-9999"), { recursive: true });
  writeFileSync(path.join(home, "browsers", "chromium-9999", "INSTALLATION_COMPLETE"), "");
}

describe("R822 B：参数和独立浏览器生命周期", () => {
  it("RB1 输出/时长校验；有声启动去掉静音，未 start 也关闭浏览器", async () => {
    const home = tmp();
    try {
      await assert.rejects(withTabRecorder({ output: "x.txt" }, async () => {}), /webm.*mp4/);
      await assert.rejects(withTabRecorder({ output: "x.webm", maxSeconds: 181 }, async () => {}), /maxSeconds/);
      fakeInstall(home); const env = { AGENT_RUNNER_HOME: home }; const launches = []; let closed = 0;
      const page = {}; const context = { newPage: async () => page, close: async () => {} };
      const load = () => ({ chromium: { launch: async (opts) => { launches.push(opts); return { newContext: async () => context, close: async () => { closed++; } }; } } });
      await assert.rejects(withTabRecorder({ output: path.join(home, "a.webm"), audio: true }, async () => {}, { env, load }), /没有调用 start/);
      assert.equal(closed, 1); assert.deepEqual(launches[0].ignoreDefaultArgs, ["--mute-audio"]);
      assert.ok(launches[0].args.includes("--auto-accept-this-tab-capture"));
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

const REAL = process.env.R729_BROWSER_HOME;
describe("R822 B：真实标签页录像", { skip: !REAL || !browserStatus({ AGENT_RUNNER_HOME: REAL }).installed ? "没设 R729_BROWSER_HOME" : false }, () => {
  let home; let env; let srv; let base;
  before(async () => {
    home = tmp(); env = { AGENT_RUNNER_HOME: home };
    symlinkSync(path.join(REAL, "browser"), path.join(home, "browser")); symlinkSync(path.join(REAL, "browsers"), path.join(home, "browsers"));
    srv = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      if (req.url === "/other") { res.end("<title>另一页</title>另一页"); return; }
      res.end(`<title>标签页录像</title><style>#b{width:90px;height:90px;background:#36c;animation:x .8s infinite alternate}@keyframes x{to{transform:translateX(250px);background:#c3c}}</style><div id="b"></div><script>
        window.startAudio = async () => { const C = window.AudioContext || window.webkitAudioContext; const ctx = new C(); const osc = ctx.createOscillator(); const gain = ctx.createGain();
          osc.frequency.value = 440; gain.gain.value = .12; osc.connect(gain); gain.connect(ctx.destination); osc.start(); await ctx.resume(); window.__audio = {ctx,osc}; };
      </script>`);
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r)); base = `http://127.0.0.1:${srv.address().port}`;
  });
  after(() => { srv?.close(); rmSync(home, { recursive: true, force: true }); });
  const output = (name) => path.join(home, name);

  it("RB10 无声 WebM、指针、回调结果和自动停止", async () => {
    const out = output("silent.webm");
    const r = await withTabRecorder({ output: out, showCursor: true, maxSeconds: 1 }, async ({ page, start, stop }) => {
      await page.goto(base); const state = await start(); assert.equal(state.audioTracks, 0);
      assert.equal(await page.evaluate(() => !!window.__agentHubRecordPointer), true);
      await page.mouse.move(100, 100); await page.waitForTimeout(1300);
      const saved = await stop(); assert.equal(saved.path, out);
      assert.equal(await page.evaluate(() => !!window.__agentHubRecordPointer), false);
      return "验收结果";
    }, { env });
    assert.equal(r.result, "验收结果"); assert.ok(existsSync(out));
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type", "-of", "json", out], { encoding: "utf8" }));
    assert.ok(probe.streams.some((s) => s.codec_type === "video")); assert.equal(probe.streams.some((s) => s.codec_type === "audio"), false);
  });

  it("RB11 有声 MP4：真实音量非静音，H.264 + AAC", async () => {
    const out = output("audio.mp4");
    const r = await withTabRecorder({ output: out, audio: true, maxSeconds: 10 }, async ({ page, start }) => {
      await page.goto(base); await page.evaluate(() => window.startAudio());
      const state = await start(); assert.equal(state.audioTracks, 1); await page.waitForTimeout(700);
    }, { env });
    assert.equal(r.path, out); assert.ok(existsSync(out));
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name", "-of", "json", out], { encoding: "utf8" }));
    assert.ok(probe.streams.some((s) => s.codec_name === "h264")); assert.ok(probe.streams.some((s) => s.codec_name === "aac"));
    assert.ok(Number(probe.format.duration) > 0.2 && Number(probe.format.duration) < 10);
    const vol = spawnSync("ffmpeg", ["-hide_banner", "-i", out, "-vn", "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" });
    const max = Number(/max_volume:\s*(-?[\d.]+)/.exec(vol.stderr)?.[1]);
    assert.ok(Number.isFinite(max) && max > -60, `音频不能是静音：${vol.stderr.slice(-500)}`);
  });

  it("RB13 A 当前浏览器与 B 独立标签页可同时录像", async () => {
    const m = createBrowserManager({ env, showWindow: false }); const aOut = output("current-a.mp4"); const bOut = output("independent-b.webm");
    try {
      await m.run("bot-current", "open", { url: base }); await m.run("bot-current", "record_start", { path: aOut, max_seconds: 10 });
      const b = withTabRecorder({ output: bOut, maxSeconds: 10 }, async ({ page, start }) => { await page.goto(base); await start(); await page.waitForTimeout(500); }, { env });
      await m.run("bot-current", "hover", { x: 100, y: 100 });
      assert.equal((await b).path, bOut); assert.equal((await m.run("bot-current", "record_stop")).path, aOut);
      assert.ok(existsSync(aOut) && existsSync(bOut));
    } finally { await m.closeAll(); }
  });

  it("RB12 录制中跳转不能假成功；两个独立录制互不串文件", async () => {
    await assert.rejects(withTabRecorder({ output: output("jump.webm"), maxSeconds: 10 }, async ({ page, start }) => {
      await page.goto(base); await start(); await page.goto(`${base}/other`);
    }, { env }), /没有完整保存|不完整/);
    const one = output("one.webm"); const two = output("two.webm");
    const record = (out, text) => withTabRecorder({ output: out, maxSeconds: 10 }, async ({ page, start }) => {
      await page.goto(base); await start(); await page.evaluate((t) => { document.body.dataset.owner = t; }, text); await page.waitForTimeout(300);
    }, { env });
    const [a, b] = await Promise.all([record(one, "甲"), record(two, "乙")]);
    assert.equal(a.path, one); assert.equal(b.path, two); assert.ok(existsSync(one) && existsSync(two)); assert.notEqual(one, two);
  });
});
