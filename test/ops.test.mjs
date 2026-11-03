// @意图#R636(2026-10-27): 运行器单测：目录外绝对路径、../、越界符号链接（含悬空的）都拒绝；目录内正常读写、改、跑命令；超时和中止杀进程。
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { opBash, opEdit, opRead, opWrite, resolveInside, shellFor } from "../ops.mjs";
import { parseArgs, saveConfig, loadConfig } from "../runner.mjs";
import { statSync } from "node:fs";

let base;
let root;
let outside;
before(() => {
  base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "r636-runner-")));
  root = path.join(base, "auth");
  outside = path.join(base, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(path.join(root, "a.txt"), "第一行\n第二行\n");
  writeFileSync(path.join(outside, "secret.txt"), "秘密");
  symlinkSync(path.join(outside, "secret.txt"), path.join(root, "link-out"));
  symlinkSync(path.join(outside, "nope.txt"), path.join(root, "dangling-out"));
  symlinkSync(path.join(root, "a.txt"), path.join(root, "link-in"));
  symlinkSync(outside, path.join(root, "dir-out"));
});
after(() => rmSync(base, { recursive: true, force: true }));

describe("R636 运行器：路径", () => {
  it("R1 目录外绝对路径拒绝", async () => {
    await assert.rejects(opRead({ path: path.join(outside, "secret.txt") }, root), /目录外路径已拒绝/);
    await assert.rejects(opWrite({ path: path.join(outside, "x.txt"), content: "x" }, root), /目录外路径已拒绝/);
    assert.equal(existsSync(path.join(outside, "x.txt")), false);
  });
  it("R2 ../ 拒绝", async () => {
    await assert.rejects(opRead({ path: "../outside/secret.txt" }, root), /目录外路径已拒绝/);
    await assert.rejects(opEdit({ path: "sub/../../outside/secret.txt", edits: [{ oldText: "秘密", newText: "x" }] }, root), /目录外路径已拒绝/);
    assert.equal(readFileSync(path.join(outside, "secret.txt"), "utf8"), "秘密");
  });
  it("R3 越界符号链接拒绝（文件、目录、悬空的）", async () => {
    await assert.rejects(opRead({ path: "link-out" }, root), /目录外路径已拒绝/);
    await assert.rejects(opRead({ path: "dir-out/secret.txt" }, root), /目录外路径已拒绝/);
    await assert.rejects(opWrite({ path: "dangling-out", content: "x" }, root), /目录外路径已拒绝/);
    await assert.rejects(opWrite({ path: "dir-out/new.txt", content: "x" }, root), /目录外路径已拒绝/);
    assert.equal(existsSync(path.join(outside, "nope.txt")), false);
    assert.equal(existsSync(path.join(outside, "new.txt")), false);
  });
  it("R4 ~ 指家目录，不在授权目录里就拒绝", async () => {
    await assert.rejects(resolveInside("~/.ssh/id_rsa", root), /目录外路径已拒绝/);
  });
  it("R5 目录内正常读、写（含新建上级目录）、目录内符号链接可读", async () => {
    const r = await opRead({ path: "a.txt" }, root);
    assert.deepEqual(r, { kind: "text", text: "第一行\n第二行\n" });
    assert.equal((await opRead({ path: "link-in" }, root)).text, "第一行\n第二行\n");
    assert.equal((await opRead({ path: path.join(root, "a.txt") }, root)).kind, "text");
    await opWrite({ path: "new/dir/b.txt", content: "你好" }, root);
    assert.equal(readFileSync(path.join(root, "new/dir/b.txt"), "utf8"), "你好");
  });
  it("R6 edit 和 pi 原版一样：唯一匹配才改，找不到、多处匹配都报错", async () => {
    writeFileSync(path.join(root, "e.txt"), "\uFEFFx = 1\r\ny = 2\r\n");
    await opEdit({ path: "e.txt", edits: [{ oldText: "y = 2", newText: "y = 3" }] }, root);
    assert.equal(readFileSync(path.join(root, "e.txt"), "utf8"), "\uFEFFx = 1\r\ny = 3\r\n"); // 换行和 BOM 照原样
    await assert.rejects(opEdit({ path: "e.txt", edits: [{ oldText: "zzz", newText: "q" }] }, root), /Could not find the exact text/);
    writeFileSync(path.join(root, "d.txt"), "a\na\n");
    await assert.rejects(opEdit({ path: "d.txt", edits: [{ oldText: "a", newText: "b" }] }, root), /Found 2 occurrences/);
  });
  it("R7 读目录报错、空路径报错", async () => {
    await assert.rejects(opRead({ path: "." }, root), /是目录/);
    await assert.rejects(opRead({ path: "" }, root), /路径是空的/);
  });
});

describe("R636 运行器：bash", () => {
  it("B1 工作目录是授权目录，输出边跑边给", async () => {
    const chunks = [];
    const r = await opBash({ command: "pwd; echo hi >&2; exit 3" }, root, { onData: (d) => chunks.push(String(d)) });
    assert.equal(r.exitCode, 3);
    assert.match(chunks.join(""), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(chunks.join(""), /hi/);
  });
  it("B2 超时杀掉整个进程组", async () => {
    const t0 = Date.now();
    const r = await opBash({ command: "sleep 30 & sleep 30; echo done", timeout: 0.5 }, root);
    assert.equal(r.timedOut, true);
    assert.ok(Date.now() - t0 < 5000);
  });
  it("B3 中止信号杀进程", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const r = await opBash({ command: "sleep 30" }, root, { signal: ac.signal });
    assert.equal(r.aborted, true);
  });
  it("B4 timeout 不合法报错", async () => {
    await assert.rejects(opBash({ command: "true", timeout: -1 }, root), /Invalid timeout/);
  });
  // @意图#R721(2026-11-02): Windows 用 PowerShell 跑，中文和退出码靠 -EncodedCommand + exit $LASTEXITCODE 解决
  it("B5 Windows 选 PowerShell，脚本是 UTF-16LE base64", () => {
    const w = shellFor("echo 中文测试", "win32");
    assert.equal(w.file, "powershell.exe");
    assert.deepEqual(w.args.slice(0, 7), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-OutputFormat", "Text", "-EncodedCommand"]);
    const script = Buffer.from(w.args[7], "base64").toString("utf16le");
    assert.match(script, /echo 中文测试/);
    assert.match(script, /exit \$LASTEXITCODE/);
    assert.match(script, /\[Console\]::OutputEncoding=\[Text\.Encoding\]::UTF8/);
    // CLIXML 和中文乱码都是这两个前缀管的：关进度、把错误拼成字符串
    assert.match(script, /\$ProgressPreference = 'SilentlyContinue'/);
    assert.match(script, /2>&1 \| ForEach-Object/);
    assert.deepEqual(shellFor("echo hi", "darwin"), { file: "bash", args: ["-c", "echo hi"] });
    assert.deepEqual(shellFor("echo hi", "linux"), { file: "bash", args: ["-c", "echo hi"] });
  });
});

describe("R636 运行器：配置", () => {
  it("C1 配置文件权限 600，参数解析", () => {
    const f = path.join(base, "cfg", "config.json");
    saveConfig({ token: "t", dir: root }, f);
    assert.equal(statSync(f).mode & 0o777, 0o600);
    assert.equal(loadConfig(f).dir, root);
    assert.deepEqual(parseArgs(["pair", "ABCD", "--dir", "/x"]), { cmd: "pair", positional: ["ABCD"], dir: "/x" });
    assert.throws(() => parseArgs(["start", "--bad"]), /不认识的参数/);
    // R663：pair 认 --start（不带值）；不带时没有 start 这个键（老用法不变）
    assert.deepEqual(parseArgs(["pair", "ABCD", "--start", "--server", "http://x"]), { cmd: "pair", positional: ["ABCD"], start: true, server: "http://x" });
    assert.equal("start" in parseArgs(["pair", "ABCD"]), false);
  });
});
