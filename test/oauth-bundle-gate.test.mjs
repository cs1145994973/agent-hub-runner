// @意图#R912(2026-11-20): 打包把关本身的测试：pi-ai 登录相关文件和锁文件记录的 sha256 对不上时，打包 / 检查都必须停下（退出码 2），
// 不碰现有产物、不跑验证；加 --accept 才继续。公开仓（agent-hub-runner）里没有 release/ 和 server/node_modules，自动跳过。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, "../../release/oauth-bundle.mjs");
const HUB = path.join(here, "../..");
const hasTools = existsSync(SCRIPT) && existsSync(path.join(HUB, "server/node_modules/esbuild/lib/main.js")) && existsSync(path.join(HUB, "release/oauth-bundle.lock.json"));

test("diffInputs：版本变、文件内容变、多文件、少文件都列出来；完全一样时为空", { skip: !existsSync(SCRIPT) }, async () => {
  const { diffInputs } = await import(pathToFileURL(SCRIPT).href);
  const lock = { piAiVersion: "1.1.0", inputs: { "a.js": "1", "b.js": "2" } };
  assert.deepEqual(diffInputs(lock, "1.1.0", { "a.js": "1", "b.js": "2" }), []);
  const d = diffInputs(lock, "1.2.0", { "a.js": "9", "c.js": "3" });
  assert.equal(d.length, 4);
  assert.ok(d.some((x) => x.includes("1.1.0 → 1.2.0")));
  assert.ok(d.some((x) => x.includes("内容变了 a.js")));
  assert.ok(d.some((x) => x.includes("新增输入文件 c.js")));
  assert.ok(d.some((x) => x.includes("少了输入文件 b.js")));
});

test("登录代码的 sha256 和锁文件不一致：打包和 --check 都停下（退出码 2），产物不动、不跑验证；--accept 才放行", { skip: !hasTools }, async () => {
  const { main } = await import(pathToFileURL(SCRIPT).href);
  const dir = mkdtempSync(path.join(os.tmpdir(), "oauth-gate-"));
  try {
    const lock = JSON.parse(readFileSync(path.join(HUB, "release/oauth-bundle.lock.json"), "utf8"));
    const key = Object.keys(lock.inputs).find((f) => f.endsWith("openai-codex.js"));
    lock.inputs[key] = "0".repeat(64); // 假装上游改了 Codex 登录代码
    const lockFile = path.join(dir, "lock.json");
    const outFile = path.join(dir, "oauth.bundle.mjs");
    writeFileSync(lockFile, JSON.stringify(lock));
    writeFileSync(outFile, "// old\n");
    let verified = 0;
    const verify = () => { verified += 1; return true; };
    const errs = [];
    const orig = console.error;
    console.error = (...a) => errs.push(a.join(" "));
    try {
      assert.equal(await main([], { lockFile, outFile, verify }), 2);
      assert.equal(await main(["--check"], { lockFile, outFile, verify }), 2);
    } finally { console.error = orig; }
    assert.ok(errs.some((e) => e.includes(`内容变了 ${key}`)), errs.join("\n"));
    assert.equal(readFileSync(outFile, "utf8"), "// old\n");
    assert.equal(verified, 0);
    assert.equal(JSON.parse(readFileSync(lockFile, "utf8")).inputs[key], "0".repeat(64));
    // 人工看过后 --accept：重新记录校验值、产物换新（验证这里用假的，真验证见 oauth-bundle.test.mjs）
    const log = console.log; console.log = () => {};
    try { assert.equal(await main(["--accept"], { lockFile, outFile, verify }), 0); } finally { console.log = log; }
    assert.equal(verified, 1);
    assert.notEqual(JSON.parse(readFileSync(lockFile, "utf8")).inputs[key], "0".repeat(64));
    assert.ok(statSync(outFile).size > 10000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("pi-ai 版本和锁定的不一样：不加 --accept 直接停", { skip: !hasTools }, async () => {
  const { main } = await import(pathToFileURL(SCRIPT).href);
  const dir = mkdtempSync(path.join(os.tmpdir(), "oauth-gate-"));
  try {
    const lock = JSON.parse(readFileSync(path.join(HUB, "release/oauth-bundle.lock.json"), "utf8"));
    lock.pinnedVersion = "0.0.1";
    const lockFile = path.join(dir, "lock.json");
    writeFileSync(lockFile, JSON.stringify(lock));
    const orig = console.error; console.error = () => {};
    try { assert.equal(await main([], { lockFile, outFile: path.join(dir, "x.mjs"), verify: () => true }), 1); } finally { console.error = orig; }
    assert.equal(existsSync(path.join(dir, "x.mjs")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
