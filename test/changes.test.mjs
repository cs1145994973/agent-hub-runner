// @意图#R690(2026-11-01): 改动记录点开查看（运行器这边）：对比带两边行号、CRLF/BOM、多处合并；写文件记录；打码（和服务器共用样例）；64 KB 截断；30 天清理；
// id 不对拒绝；存失败不影响写改；change_get 找到 / 找不到，没选目录也能取
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { buildChangeRecord, changesDirFor, createChangeStore, diffLines, hunksOf, KEEP_MS, MAX_RECORD_BYTES, redactSecrets, splitLines } from "../changes.mjs";
import { createSession, saveConfig } from "../runner.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const CASES = JSON.parse(readFileSync(path.join(here, "fixtures", "redact-cases.json"), "utf8"));
const ID = (c) => `auto-${c.repeat(32)}`;

describe("R690 改动记录", () => {
  let base;
  before(() => { base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "r690-"))); });
  after(() => { rmSync(base, { recursive: true, force: true }); });
  const quiet = () => {};
  const collect = () => { const out = []; return { out, send: (m) => out.push(m) }; };

  it("X1 打码：共用样例逐条一致", () => {
    for (const c of CASES) assert.equal(redactSecrets(c.in), c.out, c.name);
  });

  it("X2 对比带改前、改后行号；连着的改动先删后加；前后 3 行；隔得近的两处并成一处，远的分开", () => {
    const a = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"], b = ["a", "B", "c", "d", "e", "f", "g", "h", "i", "J", "k"];
    const rows = diffLines(a, b);
    assert.deepEqual(rows.slice(0, 3), [{ t: " ", o: 1, n: 1, s: "a" }, { t: "-", o: 2, n: null, s: "b" }, { t: "+", o: null, n: 2, s: "B" }]);
    const hs = hunksOf(rows);
    assert.equal(hs.length, 2);
    assert.deepEqual([hs[0].old_start, hs[0].new_start, hs[0].lines.length], [1, 1, 6]);
    assert.deepEqual([hs[1].old_start, hs[1].new_start], [7, 7]);
    assert.deepEqual(hs[1].lines.slice(-3).map((l) => [l.t, l.o, l.n]), [["-", 10, null], ["+", null, 10], ["+", null, 11]]);
    const near = hunksOf(diffLines(["1", "x", "2", "3", "4", "y", "5"], ["1", "X", "2", "3", "4", "Y", "5"]));
    assert.equal(near.length, 1);
  });

  it("X3 CRLF、BOM、末尾换行不多出一行", () => {
    assert.deepEqual(splitLines("\uFEFFa\r\nb\r\n"), ["a", "b"]);
    const r = buildChangeRecord({ id: ID("1"), tool: "edit", path: "w.txt", before: "\uFEFFx\r\ny\r\n", after: "\uFEFFx\r\nY\r\n" });
    assert.equal(r.added, 1); assert.equal(r.removed, 1);
    assert.deepEqual(r.hunks[0].lines.map((l) => l.s), ["x", "y", "Y"]);
  });

  it("X4 写文件记录：内容打码、总行数、字数；超过 64 KB 截断带标记；改文件超了也截断", () => {
    const w = buildChangeRecord({ id: ID("2"), tool: "write", path: "n.md", content: "# 说明\nAPI_KEY=abc\n" });
    assert.deepEqual([w.tool, w.lines, w.total_lines, w.chars, w.truncated], ["write", ["# 说明", "API_KEY=***"], 2, 17, false]);
    const big = Array.from({ length: 5000 }, (_, i) => `第 ${i} 行 ${"内容".repeat(10)}`).join("\n");
    const wb = buildChangeRecord({ id: ID("3"), tool: "write", path: "big.txt", content: big });
    assert.equal(wb.truncated, true); assert.equal(wb.total_lines, 5000);
    assert.ok(Buffer.byteLength(JSON.stringify(wb)) <= MAX_RECORD_BYTES);
    const eb = buildChangeRecord({ id: ID("4"), tool: "edit", path: "big.txt", before: "", after: big });
    assert.equal(eb.truncated, true); assert.equal(eb.added, 5000);
    assert.ok(Buffer.byteLength(JSON.stringify(eb)) <= MAX_RECORD_BYTES);
  });

  it("X5 存取：600 权限；id 不对拒绝存、取回 null；30 天前的清掉（强制清和存时顺手清，存时最多一小时一次）", async () => {
    const dir = path.join(base, "x5", "edits");
    let t = Date.now();
    const st = createChangeStore(dir, { now: () => t });
    await st.save(ID("a"), { hi: 1 });
    assert.equal(statSync(path.join(dir, `${ID("a")}.json`)).mode & 0o777, 0o600);
    assert.deepEqual(await st.get(ID("a")), { hi: 1 });
    await assert.rejects(st.save("../x", {}));
    assert.equal(await st.get("../../config"), null);
    assert.equal(await st.get(ID("b")), null);
    const old = new Date(t - KEEP_MS - 60_000);
    utimesSync(path.join(dir, `${ID("a")}.json`), old, old);
    await st.save(ID("c"), {}); // 刚清过（存 a 时），一小时内不再清
    assert.ok(existsSync(path.join(dir, `${ID("a")}.json`)));
    t += 61 * 60_000;
    await st.save(ID("d"), {});
    assert.equal(existsSync(path.join(dir, `${ID("a")}.json`)), false);
    assert.ok(existsSync(path.join(dir, `${ID("c")}.json`)));
    utimesSync(path.join(dir, `${ID("c")}.json`), old, old);
    assert.equal(await st.clean(true), 1);
  });

  it("X6 会话：write / edit 带 change_id 才存记录（edit 是对比）；change_get 找到 / 找不到；没选目录也能取；存不上只记日志、写改照样成功", async () => {
    const d = path.join(base, "x6dir"); mkdirSync(d); writeFileSync(path.join(d, "a.txt"), "one\ntwo\nthree\n");
    const file = path.join(base, "x6", "dev.json");
    saveConfig({ server: "http://127.0.0.1:1", device_id: "dev-x", token: "t", name: "m", bot_dirs: { A: d } }, file);
    const cfg = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(changesDirFor(file), path.join(base, "x6", "edits"));
    const logs = [];
    const s = createSession(cfg, { log: (m) => logs.push(m), platform: "darwin", file });
    const c = collect();
    await s.onMessage({ type: "call", id: "1", op: "edit", bot_id: "A", args: { path: "a.txt", edits: [{ oldText: "two", newText: "TWO" }], change_id: ID("e") } }, c.send);
    await s.onMessage({ type: "call", id: "2", op: "write", bot_id: "A", args: { path: "b.txt", content: "x\ny\n", change_id: ID("f") } }, c.send);
    await s.onMessage({ type: "call", id: "3", op: "write", bot_id: "A", args: { path: "c.txt", content: "z" } }, c.send);
    assert.deepEqual(c.out.map((m) => m.ok), [true, true, true]);
    assert.equal(c.out[0].record, undefined); // 结果里不带记录内容
    const g = collect();
    await s.onMessage({ type: "change_get", id: "g1", change_id: ID("e") }, g.send);
    await s.onMessage({ type: "change_get", id: "g2", change_id: ID("f") }, g.send);
    await s.onMessage({ type: "change_get", id: "g3", change_id: ID("0") }, g.send);
    await s.onMessage({ type: "change_get", id: "g4", change_id: "../dev" }, g.send);
    assert.deepEqual(g.out.map((m) => [m.type, m.id, m.ok, m.found]), [["change_result", "g1", true, true], ["change_result", "g2", true, true], ["change_result", "g3", true, false], ["change_result", "g4", true, false]]);
    assert.deepEqual(g.out[0].record.hunks[0].lines.map((l) => `${l.t}${l.s}`), [" one", "-two", "+TWO", " three"]);
    assert.deepEqual(g.out[1].record.lines, ["x", "y"]);
    // 没选目录的 bot 发来的也能取（change_get 不看目录）
    const s2 = createSession({ ...cfg, bot_dirs: {} }, { log: quiet, platform: "darwin", file });
    const g2 = collect();
    await s2.onMessage({ type: "change_get", id: "g5", change_id: ID("e") }, g2.send);
    assert.equal(g2.out[0].found, true);
    // 存不上：edits 是个文件
    const file3 = path.join(base, "x6b", "dev.json");
    saveConfig({ server: "http://127.0.0.1:1", device_id: "dev-x", token: "t", name: "m", bot_dirs: { A: d } }, file3);
    writeFileSync(path.join(base, "x6b", "edits"), "not a dir");
    const s3 = createSession(JSON.parse(readFileSync(file3, "utf8")), { log: (m) => logs.push(m), platform: "darwin", file: file3 });
    const c3 = collect();
    await s3.onMessage({ type: "call", id: "4", op: "write", bot_id: "A", args: { path: "d.txt", content: "ok", change_id: ID("9") } }, c3.send);
    assert.equal(c3.out[0].ok, true);
    assert.equal(readFileSync(path.join(d, "d.txt"), "utf8"), "ok");
    assert.ok(logs.some((m) => m.includes("改动记录没存上")));
    chmodSync(path.join(base, "x6b", "edits"), 0o644);
  });
});
