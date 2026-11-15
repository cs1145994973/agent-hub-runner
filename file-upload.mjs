// @意图#R823(2026-11-14): 把本机文件流式上传到服务器一次性票据；不把文件内容塞进 WebSocket/Base64。
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInside } from "./ops.mjs";

export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
const MIME = {
  txt: "text/plain", md: "text/markdown", json: "application/json", csv: "text/csv", pdf: "application/pdf",
  zip: "application/zip", mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", wav: "audio/wav",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
export const uploadMime = (name) => MIME[path.extname(name).slice(1).toLowerCase()] ?? "application/octet-stream";

/** path 按 bot 当前目录解析；upload 是服务器给的相对票据地址。 */
export async function uploadLocalFile({ server, upload, path: rawPath, root, signal, maxBytes = MAX_UPLOAD_BYTES, fetchImpl = fetch }) {
  if (typeof upload !== "string" || !upload.startsWith("/devices/file-upload/")) throw new Error("上传地址不对");
  if (signal?.aborted) throw new Error("已中止");
  const real = await resolveInside(rawPath, root);
  const stat = await fs.stat(real);
  if (!stat.isFile()) throw new Error(`${rawPath} 不是普通文件`);
  if (!stat.size) throw new Error("文件是空的");
  const allowance = Math.min(MAX_UPLOAD_BYTES, Number.isFinite(maxBytes) ? Math.max(0, maxBytes) : MAX_UPLOAD_BYTES);
  if (stat.size > allowance) throw new Error(allowance < MAX_UPLOAD_BYTES ? "这批文件合计不能超过 500 MB，请分批发送" : "文件太大，每个最多 200 MB");
  const base = new URL(server.endsWith("/") ? server : `${server}/`);
  const url = new URL(upload, base);
  if (url.origin !== base.origin) throw new Error("上传地址和服务器不一致");
  const name = path.basename(real);
  const stream = createReadStream(real);
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream", "content-length": String(stat.size),
        "x-file-name": encodeURIComponent(name), "x-file-mime": uploadMime(name),
      },
      body: stream, duplex: "half", signal,
    });
  } catch (e) { stream.destroy(); throw e; }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    let message = `上传失败（HTTP ${response.status}）`;
    try { message = JSON.parse(text).error || message; } catch { if (text) message = `${message}：${text.slice(0, 160)}`; }
    throw new Error(message);
  }
  const attachment = await response.json();
  if (!attachment || typeof attachment.id !== "string") throw new Error("服务器没回附件编号");
  return attachment;
}
