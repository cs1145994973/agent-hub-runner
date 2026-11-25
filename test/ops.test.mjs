// @意图#R636(2026-10-27): 运行器单测：路径解析、读写改、跑命令、超时和中止杀进程。
// @意图#R758(2026-11-08): 工作目录只是默认 cwd；绝对路径、../、~ 和指向目录外的符号链接都允许访问（整台电脑）。
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, statSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import { opBash, opEdit, opRead, opWrite, resolveInside, shellFor } from "../ops.mjs";
import { parseArgs, saveConfig, loadConfig } from "../runner.mjs";

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
  it("R1 默认目录外绝对路径可读写", async () => {
    assert.equal((await opRead({ path: path.join(outside, "secret.txt") }, root)).text, "秘密");
    await opWrite({ path: path.join(outside, "x.txt"), content: "x" }, root);
    assert.equal(readFileSync(path.join(outside, "x.txt"), "utf8"), "x");
  });
  it("R2 ../ 可读写", async () => {
    assert.equal((await opRead({ path: "../outside/secret.txt" }, root)).text, "秘密");
    writeFileSync(path.join(outside, "edit.txt"), "秘密");
    await opEdit({ path: "sub/../../outside/edit.txt", edits: [{ oldText: "秘密", newText: "x" }] }, root);
    assert.equal(readFileSync(path.join(outside, "edit.txt"), "utf8"), "x");
  });
  it("R3 指向默认目录外的符号链接也可访问（文件、目录、悬空的）", async () => {
    assert.equal((await opRead({ path: "link-out" }, root)).text, "秘密");
    assert.equal((await opRead({ path: "dir-out/secret.txt" }, root)).text, "秘密");
    await opWrite({ path: "dangling-out", content: "x" }, root);
    await opWrite({ path: "dir-out/new.txt", content: "x" }, root);
    assert.equal(readFileSync(path.join(outside, "nope.txt"), "utf8"), "x");
    assert.equal(readFileSync(path.join(outside, "new.txt"), "utf8"), "x");
  });
  it("R4 ~ 指家目录，可解析到真实路径", async () => {
    assert.equal(await resolveInside("~", root), os.homedir());
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

const isWin = process.platform === "win32";
/** 进程还在不在（Windows 用 tasklist，POSIX 用 kill 0）。 */
function isAlive(pid) {
  if (!pid) return false;
  if (!isWin) { try { process.kill(pid, 0); return true; } catch { return false; } }
  const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], { encoding: "utf8", windowsHide: true });
  return String(r.stdout ?? "").includes(String(pid));
}

describe("R636 运行器：bash", () => {
  it("B1 工作目录是授权目录，输出边跑边给", { skip: isWin ? "bash 语法；Windows 看 B1w" : false }, async () => {
    const chunks = [];
    const r = await opBash({ command: "pwd; echo hi >&2; exit 3" }, root, { onData: (d) => chunks.push(String(d)) });
    assert.equal(r.exitCode, 3);
    assert.match(chunks.join(""), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\/g, "\\\\")));
    assert.match(chunks.join(""), /hi/);
  });
  // @意图#R944(2026-11-24): Windows 版 B1：PowerShell 写当前目录 + 写 stderr + 退出码 3（中文/退出码靠 -EncodedCommand + exit $LASTEXITCODE）
  it("B1w Windows：当前目录、错误输出、退出码 3", { skip: isWin ? false : "Windows only" }, async () => {
    const chunks = [];
    const r = await opBash({ command: "(Get-Location).Path; Write-Error 'hi'; exit 3" }, root, { onData: (d) => chunks.push(String(d)) });
    assert.equal(r.exitCode, 3);
    assert.ok(chunks.join("").includes(root), `输出里应有工作目录：${chunks.join("")}`);
    assert.match(chunks.join(""), /hi/);
    // 错误流不能是 CLIXML 垃圾
    assert.ok(!chunks.join("").includes("CLIXML"), "错误流不应出现 CLIXML");
  });
  it("B2 超时杀掉整个进程组", { skip: isWin ? "bash 语法；Windows 看 B2w" : false }, async () => {
    const t0 = Date.now();
    const r = await opBash({ command: "sleep 30 & sleep 30; echo done", timeout: 0.5 }, root);
    assert.equal(r.timedOut, true);
    assert.ok(Date.now() - t0 < 5000);
  });
  // @意图#R944(2026-11-24): Windows 版 B2：超时后 taskkill /T /F 要把 PowerShell 的子进程一起杀掉（Windows 没有负进程组）
  it("B2w Windows：超时 taskkill /T 连子进程一起杀", { skip: isWin ? false : "Windows only" }, async () => {
    const mark = path.join(root, "child.pid");
    rmSync(mark, { force: true });
    // 起一个子 powershell 睡 60 秒，把它的 pid 写进文件，父再睡 30 秒等待被杀
    const cmd = [
      `$c = Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 60' -PassThru -WindowStyle Hidden`,
      `$c.Id | Out-File -FilePath '${mark.replace(/\\/g, "/")}' -Encoding ascii`,
      "Start-Sleep -Seconds 30",
    ].join("; ");
    const t0 = Date.now();
    const r = await opBash({ command: cmd, timeout: 2 }, root);
    assert.equal(r.timedOut, true);
    assert.ok(Date.now() - t0 < 20000, `超时没及时返回：${Date.now() - t0}ms`);
    const childPid = Number(readFileSync(mark, "utf8").trim());
    assert.ok(childPid > 0, "应拿到子进程 pid");
    // taskkill 是同步的，但进程退出可能有毫秒延迟，给一点宽限
    let alive = true;
    for (let i = 0; i < 20 && alive; i++) {
      alive = isAlive(childPid);
      if (alive) await new Promise((r2) => setTimeout(r2, 100));
    }
    assert.equal(alive, false, `子进程 ${childPid} 应被 taskkill /T 杀掉`);
  });
  it("C1p POSIX：配置文件权限 600", { skip: isWin ? "Windows 无 POSIX 权限位" : false }, () => {
    const f = path.join(base, "cfg", "config.json");
    saveConfig({ token: "t", dir: root }, f);
    assert.equal(statSync(f).mode & 0o777, 0o600);
  });
  it("B3 中止信号杀进程", { skip: isWin ? "bash 语法；Windows 看 B3w" : false }, async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const r = await opBash({ command: "sleep 30" }, root, { signal: ac.signal });
    assert.equal(r.aborted, true);
  });
  // @意图#R944(2026-11-24): Windows 版 B3：中止也走 taskkill
  it("B3w Windows：中止信号杀掉 PowerShell 及其子进程", { skip: isWin ? false : "Windows only" }, async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 800);
    const t0 = Date.now();
    const r = await opBash({ command: "Start-Sleep -Seconds 30" }, root, { signal: ac.signal });
    assert.equal(r.aborted, true);
    assert.ok(Date.now() - t0 < 15000, `中止没及时返回：${Date.now() - t0}ms`);
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
  it("C1 配置文件保存与读取，参数解析", () => {
    const f = path.join(base, "cfg", "config.json");
    saveConfig({ token: "t", dir: root }, f);
    assert.equal(loadConfig(f).dir, root);
    assert.deepEqual(parseArgs(["pair", "ABCD", "--dir", "/x"]), { cmd: "pair", positional: ["ABCD"], dir: "/x" });
    assert.throws(() => parseArgs(["start", "--bad"]), /不认识的参数/);
    // R663：pair 认 --start（不带值）；不带时没有 start 这个键（老用法不变）
    assert.deepEqual(parseArgs(["pair", "ABCD", "--start", "--server", "http://x"]), { cmd: "pair", positional: ["ABCD"], start: true, server: "http://x" });
    assert.equal("start" in parseArgs(["pair", "ABCD"]), false);
  });
});
