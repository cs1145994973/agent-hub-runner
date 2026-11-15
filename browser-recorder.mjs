// R822 A：当前页面的 CDP 截帧录像。只负责一段录像，不管 bot 浏览器生命周期。
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeFile } from "node:fs/promises";

export const DEFAULT_RECORD_FPS = 10;
export const DEFAULT_RECORD_MAX_SECONDS = 60;
export const MAX_RECORD_SECONDS = 180;

function ffmpegFor(env = process.env) {
  if (env.AGENT_HUB_FFMPEG) return env.AGENT_HUB_FFMPEG;
  for (const p of ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"]) if (existsSync(p)) return p;
  return process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
}

/** 子进程只收少量错误文本，不把视频输出读进内存。 */
export function runProcess(cmd, args, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${cmd} 执行超时`)); }, timeoutMs);
    child.stderr.on("data", (d) => { stderr = (stderr + String(d)).slice(-5000); });
    child.once("error", (e) => { clearTimeout(timer); reject(new Error(e.code === "ENOENT" ? `找不到 ${cmd}，请先安装 ffmpeg 或设置 AGENT_HUB_FFMPEG` : e.message)); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ code });
      else reject(new Error(`${cmd} 失败（${code}）：${stderr.trim().split("\n").slice(-3).join("；")}`));
    });
  });
}

export async function ensureFfmpeg(env = process.env, run = runProcess) {
  const cmd = ffmpegFor(env);
  await run(cmd, ["-version"], { timeoutMs: 5000 });
  return cmd;
}

/** B 也复用这里的 ffmpeg 查找和错误口径。 */
export async function convertWebmToMp4(input, output, { env = process.env, run = runProcess } = {}) {
  const cmd = await ensureFfmpeg(env, run);
  await run(cmd, ["-y", "-i", input, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", "-shortest", output], { timeoutMs: 120_000 });
  return output;
}

const concatPath = (p) => `'${p.replaceAll("'", "'\\''")}'`;

/** 网页内辅助指针，不读系统光标，不拦截页面事件。 */
export async function installPointerMarker(page) {
  await page.evaluate(() => {
    if (window.__agentHubRecordPointer) return;
    const dot = document.createElement("div");
    dot.setAttribute("aria-hidden", "true");
    dot.style.cssText = "position:fixed;left:0;top:0;width:14px;height:14px;border-radius:50%;background:#e11d48;border:2px solid white;box-shadow:0 0 0 2px #11182788;transform:translate(-50%,-50%);opacity:0;pointer-events:none;z-index:2147483647";
    const move = (e) => { dot.style.left = `${e.clientX}px`; dot.style.top = `${e.clientY}px`; dot.style.opacity = "1"; };
    const down = () => { dot.style.width = "10px"; dot.style.height = "10px"; };
    const up = () => { dot.style.width = "14px"; dot.style.height = "14px"; };
    const leave = () => { dot.style.opacity = "0"; };
    document.addEventListener("pointermove", move, true); document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointerup", up, true); document.documentElement.addEventListener("pointerleave", leave);
    document.documentElement.appendChild(dot);
    window.__agentHubRecordPointer = {
      remove() {
        document.removeEventListener("pointermove", move, true); document.removeEventListener("pointerdown", down, true);
        document.removeEventListener("pointerup", up, true); document.documentElement.removeEventListener("pointerleave", leave);
        dot.remove(); delete window.__agentHubRecordPointer;
      },
    };
  }).catch(() => {});
}

export async function removePointerMarker(page) {
  await page.evaluate(() => { window.__agentHubRecordPointer?.remove(); }).catch(() => {});
}

/**
 * 一段 CDP 录像。stop 幂等；自动到时与手动停止共用同一个 Promise。
 * run 可注入假 ffmpeg，便于不依赖本机软件的单元测试。
 */
export function createCdpRecorder({ page, output, fps = DEFAULT_RECORD_FPS, maxSeconds = DEFAULT_RECORD_MAX_SECONDS, showCursor = false, env = process.env, run = runProcess, now = () => Date.now() / 1000 }) {
  let session = null;
  let ffmpegCmd = "";
  let workDir = "";
  let started = false;
  let stopping = false;
  let finished = false;
  let stopPromise = null;
  let timer = null;
  let sequence = 0;
  let lastSavedAt = -Infinity;
  let writeQueue = Promise.resolve();
  let writeError = null;
  const frames = [];

  const onFrame = (event) => {
    if (event.sessionId !== undefined) void session?.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {});
    if (stopping) return;
    const at = Number.isFinite(event.metadata?.timestamp) ? event.metadata.timestamp : now();
    if (at - lastSavedAt < 1 / fps) return;
    lastSavedAt = at;
    const file = path.join(workDir, `frame-${String(sequence++).padStart(6, "0")}.jpg`);
    frames.push({ file, at });
    writeQueue = writeQueue.then(() => writeFile(file, Buffer.from(event.data, "base64"))).catch((e) => { writeError = e; });
  };

  async function cleanupSession() {
    clearTimeout(timer);
    if (showCursor) await removePointerMarker(page);
    if (session) {
      session.off?.("Page.screencastFrame", onFrame);
      await session.send("Page.stopScreencast").catch(() => {});
      await session.detach().catch(() => {});
    }
  }

  async function finish() {
    stopping = true;
    await cleanupSession();
    await writeQueue;
    if (writeError) throw writeError;
    if (!frames.length) { rmSync(workDir, { recursive: true, force: true }); throw new Error("没有收到任何画面，未生成录像"); }
    const lines = ["ffconcat version 1.0"];
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      const next = frames[i + 1]?.at;
      const duration = next === undefined ? 1 / fps : Math.max(0.001, next - f.at);
      lines.push(`file ${concatPath(f.file)}`, `duration ${duration}`);
    }
    lines.push(`file ${concatPath(frames[frames.length - 1].file)}`);
    const timeline = path.join(workDir, "timeline.ffconcat");
    writeFileSync(timeline, lines.join("\n"));
    mkdirSync(path.dirname(output), { recursive: true });
    try {
      const cmd = ffmpegCmd || await ensureFfmpeg(env, run);
      await run(cmd, ["-y", "-f", "concat", "-safe", "0", "-i", timeline,
        "-vf", `fps=${fps},scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p`,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-movflags", "+faststart", "-an", output], { timeoutMs: 120_000 });
      rmSync(workDir, { recursive: true, force: true });
      return { kind: "text", text: `录像已保存：${output}`, path: output };
    } catch (e) {
      throw new Error(`${e.message}；临时帧保留在 ${workDir}`);
    }
  }

  const stop = () => {
    if (!started) return Promise.reject(new Error("还没有开始录像"));
    if (!stopPromise) stopPromise = finish().finally(() => { finished = true; });
    return stopPromise;
  };

  return {
    output,
    isFinished: () => finished,
    async refreshPointer() { if (showCursor && started && !finished) await installPointerMarker(page); },
    async start() {
      if (started) throw new Error("这段录像已经开始过");
      started = true;
      ffmpegCmd = await ensureFfmpeg(env, run);
      workDir = mkdtempSync(path.join(os.tmpdir(), "agent-hub-cdp-recording-"));
      try {
        session = await page.context().newCDPSession(page);
        session.on("Page.screencastFrame", onFrame);
        if (showCursor) await installPointerMarker(page);
        await session.send("Page.enable");
        await session.send("Page.startScreencast", { format: "jpeg", quality: 75, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 });
        timer = setTimeout(() => { void stop().catch(() => {}); }, maxSeconds * 1000);
        timer.unref?.();
        return { kind: "text", text: `已开始录制当前标签页（最长 ${maxSeconds} 秒）。完成后调用 record_stop。`, path: output };
      } catch (e) {
        await cleanupSession(); rmSync(workDir, { recursive: true, force: true }); finished = true; throw e;
      }
    },
    stop,
  };
}

