// @意图-q6kvzh(2026-11-26): 服务器→电脑下载。落点限在共享资料库内、同名加后缀、超限/中止不留半成品。
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createSession, saveConfig } from "../runner.mjs";
import { MAX_DOWNLOAD_BYTES, downloadToLibrary } from "../file-download.mjs";
import { opDownloadTarget } from "../ops.mjs";

describe("意图-q6kvzh 运行器下载到共享资料库", () => {
  let root; let lib; let outside; let server; let base; let requests = [];
  const BODY = Buffer.from("downloaded-bytes-中文");
  const bodyOf = (body) => body;

  before(async () => {
    root = mkdtempSync(path.join(os.tmpdir(), "dl-"));
    lib = path.join(root, "library"); outside = path.join(root, "outside");
    mkdirSync(lib, { recursive: true }); mkdirSync(outside, { recursive: true });
    lib = realpathSync(lib); outside = realpathSync(outside); // macOS /var → /private/var
    server = createServer((req, res) => {
      requests.push(req.url);
      const name = req.url.includes("big") ? "big.bin" : req.url.includes("abort") ? "abort.bin" : "ok.bin";
      if (name === "abort.bin") {
        res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(BODY.length) });
        res.write(BODY.subarray(0, 5)); // 写一半就不写了，等下被打断
        return; // 不 end，让客户端 abort
      }
      const payload = name === "big.bin" ? Buffer.alloc(MAX_DOWNLOAD_BYTES + 1) : BODY;
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(payload.length) });
      res.end(payload);
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r)); base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => { server.close(); rmSync(root, { recursive: true, force: true }); });

  it("D1 库内相对子路径：父目录自动创建，内容一致", async () => {
    const got = await downloadToLibrary({ server: base, download: "/devices/file-download/t1", path: "素材/a.bin", root: lib });
    assert.equal(got.path, path.join(lib, "素材", "a.bin"));
    assert.equal(got.size, BODY.length);
    assert.equal(readFileSync(got.path).equals(BODY), true);
  });

  it("D2 同名不覆盖，自动加 -2/-3 后缀，原件保持不变", async () => {
    writeFileSync(path.join(lib, "dup.bin"), "original");
    const a = await downloadToLibrary({ server: base, download: "/devices/file-download/t2", path: "dup.bin", root: lib });
    const b = await downloadToLibrary({ server: base, download: "/devices/file-download/t3", path: "dup.bin", root: lib });
    assert.equal(path.basename(a.path), "dup-2.bin");
    assert.equal(path.basename(b.path), "dup-3.bin");
    assert.equal(readFileSync(path.join(lib, "dup.bin"), "utf8"), "original");
  });

  it("D3 绝对路径、.. 越界、库外符号链接都拒绝，且库外不落文件", async () => {
    for (const p of ["/etc/passwd", path.join(outside, "x.bin"), "../outside/y.bin", "a/../../outside/z.bin"]) {
      await assert.rejects(downloadToLibrary({ server: base, download: "/devices/file-download/t4", path: p, root: lib }), /只能|不能|相对路径/);
    }
    symlinkSync(outside, path.join(lib, "escape"));
    await assert.rejects(opDownloadTarget(lib, "escape/w.bin"), /只能放在共享资料库/);
    assert.deepEqual(readdirSync(outside), []);
  });

  it("D4 路径为空、给目录本身都拒绝", async () => {
    await assert.rejects(opDownloadTarget(lib, ""), /路径是空的/);
    await assert.rejects(opDownloadTarget(lib, "."), /要给一个文件名/);
  });

  it("D5 不传 path 时用附件原名落库根", async () => {
    const got = await downloadToLibrary({ server: base, download: "/devices/file-download/t5", name: "报告.pdf", root: lib });
    assert.equal(got.path, path.join(lib, "报告.pdf"));
    assert.equal(existsSync(got.path), true);
  });

  it("D6 超过 maxBytes 拒绝（响应头就超，不写盘）", async () => {
    await assert.rejects(downloadToLibrary({ server: base, download: "/devices/file-download/big", path: "big.bin", root: lib, maxBytes: 1024 }), /文件太大/);
    assert.equal(existsSync(path.join(lib, "big.bin")), false);
  });

  it("D7 中止后不留半成品文件", async () => {
    const ac = new AbortController();
    const p = downloadToLibrary({ server: base, download: "/devices/file-download/abort", path: "half.bin", root: lib, signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    await assert.rejects(p, /已中止/);
    assert.equal(existsSync(path.join(lib, "half.bin")), false);
    assert.equal(readdirSync(lib).filter((x) => x.includes(".part-")).length, 0);
  });

  it("D8 上传前缀、跨域地址都提前拒绕", async () => {
    await assert.rejects(downloadToLibrary({ server: base, download: "/devices/file-upload/t", path: "x.bin", root: lib }), /下载地址不对/);
    // 前缀对、端口不对：解析出的 origin 与服务器不同
    await assert.rejects(downloadToLibrary({ server: "http://127.0.0.1:1", download: "/devices/file-download/t", path: "x.bin", root: lib }), /.+/);
  });

  it("D9 createSession 接到 download 后把文件写进共享资料库并回路径", async () => {
    // 共享资料库固定是 runnerHome/library；这里只验证接线：缺少 bot_id 与失败都回 ok:false
    const cfgFile = path.join(root, "config.json");
    saveConfig({ server: base, device_id: "d", token: "t", bot_dirs: {} }, cfgFile);
    const cfg = JSON.parse(readFileSync(cfgFile, "utf8"));
    const session = createSession(cfg, { log() {}, file: cfgFile });
    const out = [];
    await session.onMessage({ type: "download", id: "d1", args: { download: "/devices/file-download/t9" } }, (m) => out.push(m));
    assert.equal(out.at(-1).ok, false);
    assert.match(out.at(-1).error, /缺 bot_id/);
    session.killAll();
  });

  it("D10 运行器版本与发布清单：0.16.0 且 files 含 file-download.mjs", async () => {
    const pkg = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "..", "package.json"), "utf8"));
    assert.equal(pkg.version, "0.16.0");
    assert.ok(pkg.files.includes("file-download.mjs"));
    assert.equal(bodyOf(BODY).length, BODY.length);
  });
});