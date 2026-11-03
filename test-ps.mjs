// 验证「把 opBash 换成 PowerShell」时要注意的几件事，不连服务器。
// 用法（在 Windows 上）：node test-ps.mjs
import { spawn } from "node:child_process";

const PS = "powershell.exe";
const PS_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-OutputFormat", "Text", "-Command"];

function run(cmd, { ms = 20000 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(PS, [...PS_ARGS, cmd], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString("utf8")));
    child.stderr.on("data", (d) => (out += d.toString("utf8")));
    const timer = setTimeout(() => { out += "\n[TIMEOUT]"; child.kill("SIGKILL"); }, ms);
    child.on("error", (e) => { clearTimeout(timer); resolve({ err: `${e.code ?? ""} ${e.message}`, out, ms: Date.now() - t0 }); });
    child.on("close", (code, sig) => { clearTimeout(timer); resolve({ code, sig, out: out.trim(), ms: Date.now() - t0 }); });
  });
}

const cases = [
  ["echo", "echo hi"],
  ["中文输出", "Write-Output '中文测试 ✓'"],
  ["当前目录", "(Get-Location).Path"],
  ["&& 连写", "echo a && echo b"],
  ["分号连写", "echo a; echo b"],
  ["dir", "Get-ChildItem C:\\Users\\chensen\\winroot | Select-Object -First 2 -ExpandProperty Name"],
  ["ls 别名", "ls C:\\Users\\chensen\\winroot | Select-Object -First 1 -ExpandProperty Name"],
  ["grep 有没有", "Get-Command grep -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name"],
  ["select-string", "'hello' | Select-String -Pattern 'ell' | ForEach-Object { $_.Matches.Value }"],
  ["npm run（会失败，没 package.json）", "npm run build"],
  ["git 版本", "git --version"],
  ["退出码", "cmd /c exit 3; $LASTEXITCODE"],
  ["报错输出（看是不是 CLIXML）", "Get-Item C:\\nope\\nothing.txt"],
  ["报错输出 2", "notacommand --flag"],
];

for (const [name, cmd] of cases) {
  const r = await run(cmd);
  console.log(`--- ${name}`);
  console.log(`    exit=${r.code ?? r.err} sig=${r.sig ?? "-"} ${r.ms}ms`);
  console.log(`    out=${JSON.stringify(r.out).slice(0, 300)}`);
}
