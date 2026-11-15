// R822 B：独立 Chromium 的标签页录像。Playwright 管页面，MediaRecorder 管画面和可选音频。
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { browserStatus, HEADLESS_VIEWPORT, loadPlaywright, NOT_INSTALLED } from "./browser.mjs";
import { convertWebmToMp4, installPointerMarker, removePointerMarker, runProcess } from "./browser-recorder.mjs";

export const TAB_CAPTURE_ARGS = [
  "--autoplay-policy=no-user-gesture-required",
  "--auto-accept-camera-and-microphone-capture",
  "--auto-accept-this-tab-capture",
  "--unsafely-treat-insecure-origin-as-secure=about:blank",
];
export const MAX_TAB_RECORD_SECONDS = 180;
const MAX_OUTPUT_BYTES = 128 * 1024 * 1024;

/**
 * AI 在一次性测试脚本里使用。start 由脚本决定，能先等游戏和声音准备好。
 * 第三参数只给测试注入环境、Playwright 和 ffmpeg，不影响正常调用。
 */
export async function withTabRecorder(options, callback, deps = {}) {
  const { env = process.env, load = loadPlaywright, run = runProcess } = deps;
  if (!options || typeof options.output !== "string" || !options.output.trim()) throw new Error("withTabRecorder 要给 output（.webm 或 .mp4）");
  const output = path.resolve(options.output);
  const mp4 = output.toLowerCase().endsWith(".mp4");
  if (!mp4 && !output.toLowerCase().endsWith(".webm")) throw new Error("output 只能以 .webm 或 .mp4 结尾");
  const maxSeconds = options.maxSeconds ?? MAX_TAB_RECORD_SECONDS;
  if (!Number.isFinite(maxSeconds) || maxSeconds < 1 || maxSeconds > MAX_TAB_RECORD_SECONDS) throw new Error(`maxSeconds 要在 1～${MAX_TAB_RECORD_SECONDS} 之间`);
  const audio = options.audio === true;
  const showCursor = options.showCursor === true;
  const installed = browserStatus(env);
  if (!installed.installed) throw new Error(NOT_INSTALLED());
  mkdirSync(path.dirname(output), { recursive: true });

  const pw = load(env);
  let browser;
  let context;
  let page;
  let started = false;
  let timer = null;
  let stopPromise = null;
  let workDir = "";

  const stop = () => {
    if (!started) return Promise.reject(new Error("还没有调用 start()"));
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      clearTimeout(timer);
      let info;
      try {
        info = await page.evaluate(async () => {
          const p = window.__agentHubTabRecorder;
          if (!p) throw new Error("录制状态不存在，页面可能已跳转");
          p.manual = true;
          const blob = p.rec.state === "inactive" ? new Blob(p.chunks, { type: p.mimeType }) : await new Promise((resolve) => {
            p.rec.onstop = () => resolve(new Blob(p.chunks, { type: p.mimeType })); p.rec.stop();
          });
          p.stream.getTracks().forEach((t) => t.stop());
          if (p.unexpected || p.recError) throw new Error(p.recError || "录制轨道提前结束，录像不完整");
          const url = URL.createObjectURL(blob);
          return { url, size: blob.size };
        });
      } catch (e) {
        throw new Error(`标签页录像没有完整保存：${e.message}`);
      }
      if (showCursor) await removePointerMarker(page);
      if (!info.size) throw new Error("录像没有内容");
      if (info.size > MAX_OUTPUT_BYTES) throw new Error("录像超过 128 MB，已停止；请缩短测试或拆成多段");

      let webm = output;
      if (mp4) {
        workDir = mkdtempSync(path.join(os.tmpdir(), "agent-hub-tab-recording-"));
        webm = path.join(workDir, "recording.webm");
      }
      const downloading = page.waitForEvent("download", { timeout: 15_000 });
      await page.evaluate((url) => {
        const a = document.createElement("a"); a.href = url; a.download = "recording.webm"; a.click();
      }, info.url);
      const download = await downloading;
      await download.saveAs(webm);
      await page.evaluate((url) => URL.revokeObjectURL(url), info.url).catch(() => {});
      if (mp4) {
        try { await convertWebmToMp4(webm, output, { env, run }); rmSync(workDir, { recursive: true, force: true }); }
        catch (e) { throw new Error(`${e.message}；原始 WebM 保留在 ${webm}`); }
      }
      return { kind: "text", text: `录像已保存：${output}`, path: output };
    })();
    return stopPromise;
  };

  const start = async () => {
    if (started) throw new Error("这个 helper 只录一段；要分段请重新调用 withTabRecorder");
    if (showCursor) await installPointerMarker(page);
    const state = await page.evaluate(async ({ audio }) => {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: "browser" }, audio,
        systemAudio: "exclude", selfBrowserSurface: "include", preferCurrentTab: true,
      });
      if (!stream.getVideoTracks().length || (audio && !stream.getAudioTracks().length)) {
        stream.getTracks().forEach((t) => t.stop());
        throw new Error(audio ? "没有拿到标签页的视频轨和音频轨" : "没有拿到标签页视频轨");
      }
      const mimeType = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((x) => MediaRecorder.isTypeSupported(x));
      if (!mimeType) { stream.getTracks().forEach((t) => t.stop()); throw new Error("Chromium 没有可用的 WebM MediaRecorder"); }
      const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2_500_000, ...(audio ? { audioBitsPerSecond: 128_000 } : {}) });
      const p = { stream, rec, chunks: [], mimeType, manual: false, unexpected: false, recError: "" };
      window.__agentHubTabRecorder = p;
      rec.ondataavailable = (e) => { if (e.data.size) p.chunks.push(e.data); };
      rec.onerror = (e) => { p.recError = e.error?.message || "MediaRecorder 错误"; };
      for (const track of stream.getTracks()) track.addEventListener("ended", () => { if (!p.manual) p.unexpected = true; });
      rec.start(250);
      return { mimeType, videoTracks: stream.getVideoTracks().length, audioTracks: stream.getAudioTracks().length };
    }, { audio });
    started = true;
    timer = setTimeout(() => { void stop().catch(() => {}); }, maxSeconds * 1000);
    timer.unref?.();
    return state;
  };

  try {
    browser = await pw.chromium.launch({
      channel: "chromium", headless: options.headless !== false,
      args: [...TAB_CAPTURE_ARGS], ...(audio ? { ignoreDefaultArgs: ["--mute-audio"] } : {}),
    });
    context = await browser.newContext({ viewport: options.viewport ?? HEADLESS_VIEWPORT, acceptDownloads: true });
    page = await context.newPage();
    let result;
    let saved;
    let failure = null;
    try {
      result = await callback({ page, context, start, stop });
      if (!started) throw new Error("测试脚本结束但没有调用 start()，没有生成录像");
      saved = await stop();
    } catch (e) { failure = e; }
    if (started) {
      try { await stop(); } catch (e) {
        failure = failure ? new Error(`${failure.message}；录像收尾也失败：${e.message}`, { cause: failure }) : e;
      }
    }
    if (failure) throw failure;
    return { result, path: saved.path };
  } finally {
    clearTimeout(timer);
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}
