// Windows 现状验证：直接调 runner/ops.mjs 的各个 op，不连服务器。
// 用法（在 Windows 上）：node test-windows.mjs
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runOp, realOf, resolveInside } from "./ops.mjs";

const root = path.join(os.homedir(), "winroot");
await fs.mkdir(root, { recursive: true });
const out = [];
const log = (...a) => { const s = a.map(String).join(" "); out.push(s); console.log(s); };

async function step(name, fn) {
  try {
    const r = await fn();
    const s = typeof r === "string" ? r.slice(0, 150) : JSON.stringify(r ?? null).slice(0, 250);
    log(`OK   ${name} -> ${s}`);
  } catch (e) {
    log(`FAIL ${name} -> ${e?.code ? e.code + " " : ""}${e?.message}`);
  }
}

log(`platform=${process.platform} arch=${process.arch} node=${process.version}`);
log(`root=${root} sep=${JSON.stringify(path.sep)}`);
log("");

await fs.writeFile(path.join(root, "a.txt"), "第一行\n第二行\n");
await fs.mkdir(path.join(root, "sub"), { recursive: true });

await step("read 相对路径 a.txt", () => runOp("read", { path: "a.txt" }, root));
await step("read 绝对路径", () => runOp("read", { path: path.join(root, "a.txt") }, root));
await step("read 目录 sub", () => runOp("read", { path: "sub" }, root));
await step("read ~/winroot/a.txt", () => runOp("read", { path: "~/winroot/a.txt" }, root));
await step("write sub/b.txt", () => runOp("write", { path: "sub/b.txt", content: "hello world\n" }, root));
await step("edit sub/b.txt", () => runOp("edit", { path: "sub/b.txt", edits: [{ oldText: "hello", newText: "HELLO" }] }, root));
await step("edit 不存在的文件", () => runOp("edit", { path: "nope.txt", edits: [{ oldText: "a", newText: "b" }] }, root));

await step("bash: dir", () => runOp("bash", { command: "Get-ChildItem -Name", timeout: 15 }, root, { onData: (d) => log(`  [data] ${String(d).trim().slice(0, 100)}`) }));
await step("bash: 报错命令（看中文是否乱码 / 有无 CLIXML）", () => runOp("bash", { command: "Get-Item C:\\nope\\nothing.txt", timeout: 15 }, root, { onData: (d) => log(`  [data] ${String(d).trim().slice(0, 160)}`) }));
await step("bash: echo hi", () => runOp("bash", { command: "echo hi", timeout: 15 }, root, { onData: (d) => log(`  [data] ${String(d).trim().slice(0, 100)}`) }));
await step("bash: 中文参数（-EncodedCommand 验证）", () => runOp("bash", { command: "Write-Output '中文测试 ✓'", timeout: 15 }, root, { onData: (d) => log(`  [data] ${String(d).trim().slice(0, 100)}`) }));
await step("bash: 中文写入文件再 read 验证", async () => {
  await runOp("bash", { command: "Set-Content -Path cn.txt -Value '中文内容二' -Encoding UTF8", timeout: 15 }, root);
  return runOp("read", { path: "cn.txt" }, root);
});
await step("bash: 退出码 3（应看到 exitCode:3）", () => runOp("bash", { command: "cmd /c exit 3", timeout: 15 }, root, { onData: (d) => log(`  [data] ${String(d).trim().slice(0, 80)}`) }));
await step("bash: 成功命令退出码 0", () => runOp("bash", { command: "echo ok", timeout: 15 }, root));
await step("bash: 超时 1s（应 timedOut:true 且很快返回）", async () => {
  const t0 = Date.now();
  const r = await runOp("bash", { command: "Start-Sleep -Seconds 30", timeout: 1 }, root);
  return { ...r, ms: Date.now() - t0 };
});
await step("bash: 超时后子进程真的被杀了吗", async () => {
  const marker = path.join(root, "pids.txt");
  await fs.rm(marker, { force: true });
  const r = await runOp("bash", { command: `$PID | Out-File -FilePath '${marker.replace(/\\/g, "\\\\")}' -Encoding ascii; Start-Sleep -Seconds 30`, timeout: 1.5 }, root);
  await new Promise((res) => setTimeout(res, 1200));
  const pid = (await fs.readFile(marker, "utf8").catch(() => "")).trim();
  let alive = false;
  try { process.kill(Number(pid), 0); alive = true; } catch { alive = false; }
  return { timedOut: r.timedOut, childPid: pid, stillAlive: alive };
});

await fs.writeFile(path.join(os.homedir(), "outside.txt"), "outside\n");
await step("越界 ../outside.txt（应拒绝）", () => runOp("read", { path: "../outside.txt" }, root));
await step("越界 C:\\Windows\\win.ini（应拒绝）", () => runOp("read", { path: "C:\\Windows\\win.ini" }, root));

await fs.writeFile(path.join(root, "Case.txt"), "case content\n");
await step("大小写 Case.txt 用 case.txt 读", () => runOp("read", { path: "case.txt" }, root));
await step("realOf(root)", () => realOf(root));
await step("resolveInside(sub/b.txt)", () => resolveInside("sub/b.txt", root));

log("");
log("=== 汇总（便于抄进文档） ===");
console.log(out.filter((l) => l.startsWith("OK") || l.startsWith("FAIL")).join("\n"));
