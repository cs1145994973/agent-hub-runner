// @意图-q6kvzh(2026-11-26): 服务器→电脑的下载：把用户上传给这个 bot 的附件流式写进共享资料库。
// 落点规则由 opDownloadTarget 定（库内相对路径、拒越界、同名加后缀）；这里只负责 HTTP 流、大小上限、中止后不留半成品。
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { opDownloadTarget } from "./ops.mjs";

/** 单个文件上限：与服务器上传口径一致（50 MB）。 */
export const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

const safeName = (name) => String(name ?? "").replace(/[/\\\u0000]/g, "_").trim() || "文件";

/** download 是服务器给的相对票据地址；path 是库内相对落点（空 = 用附件原名）。 */
export async function downloadToLibrary({ server, download, path: relPath, name: rawName, root, signal, maxBytes = MAX_DOWNLOAD_BYTES, fetchImpl = fetch }) {
  if (typeof download !== "string" || !download.startsWith("/devices/file-download/")) throw new Error("下载地址不对");
  if (signal?.aborted) throw new Error("已中止");
  const allowance = Math.min(MAX_DOWNLOAD_BYTES, Number.isFinite(maxBytes) ? Math.max(0, maxBytes) : MAX_DOWNLOAD_BYTES);
  const base = new URL(server.endsWith("/") ? server : `${server}/`);
  const url = new URL(download, base);
  if (url.origin !== base.origin) throw new Error("下载地址和服务器不一致");
  const target = await opDownloadTarget(root, relPath && String(relPath).trim() ? String(relPath) : safeName(rawName));
  let response;
  try {
    response = await fetchImpl(url, { method: "GET", signal });
  } catch (e) {
    throw new Error(signal?.aborted ? "已中止" : `下载失败：${e?.message ?? e}`);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    let message = `下载失败（HTTP ${response.status}）`;
    try { message = JSON.parse(text).error || message; } catch { if (text) message = `${message}：${text.slice(0, 160)}`; }
    throw new Error(message);
  }
  const length = Number(response.headers?.get?.("content-length") ?? NaN);
  if (Number.isFinite(length) && length > allowance) throw new Error(`文件太大，最多 ${Math.round(allowance / 1024 / 1024)} MB`);
  if (!response.body) throw new Error("下载失败：服务器没有返回内容");
  const out = path.join(path.dirname(target), `.${path.basename(target)}.part-${process.pid}-${Date.now()}`);
  let size = 0;
  try {
    const sink = createWriteStream(out, { mode: 0o644 });
    await pipeline(Readable.fromWeb(response.body), async function* (source) {
      for await (const chunk of source) {
        size += chunk.length;
        if (size > allowance) throw new Error(`文件太大，最多 ${Math.round(allowance / 1024 / 1024)} MB`);
        yield chunk;
      }
    }, sink);
    if (signal?.aborted) throw new Error("已中止");
    await fs.rename(out, target);
  } catch (e) {
    await fs.rm(out, { force: true }).catch(() => {});
    if (signal?.aborted) throw new Error("已中止");
    throw e;
  }
  return { path: target, size };
}
