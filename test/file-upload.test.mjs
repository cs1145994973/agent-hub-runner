import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createSession, saveConfig } from "../runner.mjs";
import { MAX_UPLOAD_BYTES, uploadLocalFile, uploadMime } from "../file-upload.mjs";

describe("R823 运行器流式发文件", () => {
  let root; let server; let base; let requests = [];
  before(async () => {
    root = mkdtempSync(path.join(os.tmpdir(), "r823-upload-"));
    server = createServer((req, res) => {
      const chunks = []; req.on("data", (d) => chunks.push(d)); req.on("end", () => {
        requests.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
        res.writeHead(201, { "content-type": "application/json" }); res.end(JSON.stringify({ id: "file-" + "a".repeat(32), kind: "file", size: requests.at(-1).body.length }));
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r)); base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => { server.close(); rmSync(root, { recursive: true, force: true }); });

  it("UF1 相对路径按 bot 目录解析，原始字节流式上传，文件名和 MIME 正确", async () => {
    mkdirSync(path.join(root, "work")); const body = Buffer.from([0, 1, 2, 255, 10]);
    writeFileSync(path.join(root, "work", "报告.pdf"), body);
    const ref = await uploadLocalFile({ server: base, upload: "/devices/file-upload/ticket-1", path: "报告.pdf", root: path.join(root, "work") });
    assert.equal(ref.id, "file-" + "a".repeat(32));
    assert.equal(requests[0].body.equals(body), true); assert.equal(requests[0].headers["content-length"], String(body.length));
    assert.equal(requests[0].headers["x-file-name"], encodeURIComponent("报告.pdf")); assert.equal(requests[0].headers["x-file-mime"], "application/pdf");
    assert.equal(uploadMime("x.mp4"), "video/mp4"); assert.equal(uploadMime("x.unknown"), "application/octet-stream");
  });

  it("UF2 目录、空文件、超过 200 MB 都在本机提前拒绝，不发请求", async () => {
    writeFileSync(path.join(root, "empty.txt"), ""); writeFileSync(path.join(root, "large.bin"), "x"); truncateSync(path.join(root, "large.bin"), MAX_UPLOAD_BYTES + 1);
    for (const p of [root, path.join(root, "empty.txt"), path.join(root, "large.bin")]) {
      const before = requests.length;
      await assert.rejects(uploadLocalFile({ server: base, upload: "/devices/file-upload/t", path: p, root }));
      assert.equal(requests.length, before);
    }
    writeFileSync(path.join(root, "batch.txt"), "12345"); const before = requests.length;
    await assert.rejects(uploadLocalFile({ server: base, upload: "/devices/file-upload/t", path: path.join(root, "batch.txt"), root, maxBytes: 4 }), /500 MB/);
    assert.equal(requests.length, before);
  });

  it("UF3 createSession 接到 file_upload 后回附件元数据", async () => {
    writeFileSync(path.join(root, "a.txt"), "hello");
    const cfgFile = path.join(root, "config.json"); saveConfig({ server: base, device_id: "d", token: "t", bot_dirs: { "bot-a": root } }, cfgFile);
    const cfg = JSON.parse(readFileSync(cfgFile, "utf8")); const session = createSession(cfg, { log() {}, file: cfgFile });
    const out = []; await session.onMessage({ type: "file_upload", id: "u1", bot_id: "bot-a", args: { path: "a.txt", upload: "/devices/file-upload/real" } }, (m) => out.push(m));
    assert.equal(out.at(-1).ok, true); assert.equal(out.at(-1).attachment.id, "file-" + "a".repeat(32));
    session.killAll();
  });

  it("UF4 已中止的 signal 不发上传请求", async () => {
    writeFileSync(path.join(root, "abort.txt"), "x"); const before = requests.length;
    await assert.rejects(uploadLocalFile({ server: base, upload: "/devices/file-upload/abort", path: path.join(root, "abort.txt"), root, signal: AbortSignal.abort() }));
    assert.equal(requests.length, before);
  });
});
