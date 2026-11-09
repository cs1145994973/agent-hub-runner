// @意图#R640(2026-10-27): 每个 bot 一个默认工作目录（弹窗函数注入，不真弹）：pick_dir 带 bot_id，选完记进对照表、写回配置（600）；调用按 bot_id 查目录；
// @意图#R758(2026-11-08): 工作目录只做默认 cwd，不再限制跨 bot/跨目录访问；没条目的 bot 仍被拒；换 A 不影响 B；老格式单一 dir 忽略；取消、非 Mac、超时中止
// @意图#R639(2026-10-27已废弃): 网页叫运行器弹窗选目录：选完写回配置、之后只认新目录；取消、根目录、非 Mac、超时中止；没目录时调用一律拒绝（R640 改成按 bot 分）
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { botDirsOf, createSession, NO_DIR, PICK_ONLY_MAC, saveConfig } from "../runner.mjs";

describe("R640 每个 bot 自己的目录", () => {
  let base;
  before(() => { base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "r640-sess-"))); });
  after(() => { rmSync(base, { recursive: true, force: true }); });
  const quiet = () => {};
  const collect = () => { const out = []; return { out, send: (m) => out.push(m) }; };
  const newCfg = (name, extra = {}) => {
    const file = path.join(base, `${name}.json`);
    saveConfig({ server: "http://127.0.0.1:1", device_id: "dev-x", token: "tok-x", name: "m", bot_dirs: {}, ...extra }, file);
    return { file, cfg: JSON.parse(readFileSync(file, "utf8")) };
  };
  const mk = (name, text) => { const d = path.join(base, name); mkdirSync(d); writeFileSync(path.join(d, "f.txt"), text); return d; };
  /** 弹窗按顺序回这些目录 */
  const picks = (...ds) => { let i = 0; return async () => ds[i++]; };
  const read = async (s, bot, p) => { const c = collect(); await s.onMessage({ type: "call", id: "c", op: "read", args: { path: p }, bot_id: bot }, c.send); return c.out.at(-1); };

  it("S1 A、B 各选目录：dir_result 带 bot_id、对照表写回配置（600）；相对路径各用各的，跨目录访问允许；没条目的 C 被拒", async () => {
    const a = mk("a1", "A 的文件"); const b = mk("b1", "B 的文件");
    const { file, cfg } = newCfg("s1");
    const s = createSession(cfg, { log: quiet, platform: "darwin", file, pickDir: picks(`${a}/`, b) });
    const c = collect();
    await s.onMessage({ type: "pick_dir", id: "p1", bot_id: "bot-a" }, c.send);
    await s.onMessage({ type: "pick_dir", id: "p2", bot_id: "bot-b" }, c.send);
    assert.deepEqual(c.out, [
      { type: "dir_result", id: "p1", ok: true, bot_id: "bot-a", dir: a },
      { type: "dir_result", id: "p2", ok: true, bot_id: "bot-b", dir: b },
    ]);
    assert.deepEqual(s.botDirs, { "bot-a": a, "bot-b": b });
    const saved = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(saved.bot_dirs, { "bot-a": a, "bot-b": b });
    assert.equal(saved.token, "tok-x");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal((await read(s, "bot-a", "f.txt")).text, "A 的文件");
    assert.equal((await read(s, "bot-b", "f.txt")).text, "B 的文件");
    assert.equal((await read(s, "bot-a", path.join(b, "f.txt"))).text, "B 的文件");
    assert.equal((await read(s, "bot-a", "../b1/f.txt")).text, "B 的文件");
    assert.equal((await read(s, "bot-b", path.join(a, "f.txt"))).text, "A 的文件");
    const w = collect();
    await s.onMessage({ type: "call", id: "w", op: "write", args: { path: path.join(b, "x.txt"), content: "x" }, bot_id: "bot-a" }, w.send);
    assert.equal(w.out.at(-1).ok, true);
    assert.equal(readFileSync(path.join(b, "x.txt"), "utf8"), "x");
    for (const bot of ["bot-c", undefined]) {
      const c2 = collect();
      for (const op of ["read", "write", "edit", "bash"]) await s.onMessage({ type: "call", id: op, op, args: { path: "f.txt", command: "ls", content: "x", edits: [] }, bot_id: bot }, c2.send);
      assert.deepEqual(c2.out.map((m) => [m.id, m.ok, m.error]), ["read", "write", "edit", "bash"].map((op) => [op, false, NO_DIR]));
    }
  });

  it("S2 换 A 的目录不影响 B；两个 bot 选同一目录也行；重新读配置后对照表还在", async () => {
    const a = mk("a2", "A 旧"); const a2 = mk("a2new", "A 新"); const b = mk("b2", "B");
    const { file, cfg } = newCfg("s2", { bot_dirs: { "bot-a": a, "bot-b": b } });
    const s = createSession(cfg, { log: quiet, platform: "darwin", file, pickDir: picks(a2, a2) });
    await s.onMessage({ type: "pick_dir", id: "p1", bot_id: "bot-a" }, () => {});
    assert.equal((await read(s, "bot-a", "f.txt")).text, "A 新");
    assert.equal((await read(s, "bot-b", "f.txt")).text, "B");
    await s.onMessage({ type: "pick_dir", id: "p2", bot_id: "bot-b" }, () => {});
    assert.deepEqual(botDirsOf(JSON.parse(readFileSync(file, "utf8"))), { "bot-a": a2, "bot-b": a2 });
  });

  it("S3 老格式配置（单一 dir）：忽略，所有 bot 都没目录；选目录后写回的配置里没有 dir 了", async () => {
    const old = mk("old3", "老目录");
    const { file, cfg } = newCfg("s3", { dir: old, bot_dirs: undefined });
    assert.equal(cfg.dir, old);
    assert.deepEqual(botDirsOf(cfg), {});
    const s = createSession(cfg, { log: quiet, platform: "darwin", file, pickDir: picks(old) });
    assert.deepEqual(s.botDirs, {});
    assert.equal((await read(s, "bot-a", "f.txt")).error, NO_DIR);
    await s.onMessage({ type: "pick_dir", id: "p", bot_id: "bot-a" }, () => {});
    const saved = JSON.parse(readFileSync(file, "utf8"));
    assert.equal("dir" in saved, false);
    assert.deepEqual(saved.bot_dirs, { "bot-a": old });
    assert.deepEqual(botDirsOf({ bot_dirs: { x: 1, y: "", z: "/tmp" } }), { z: "/tmp" }); // 坏条目不认
  });

  it("S4 点了取消：回 cancelled（带 bot_id），对照表和配置都不变；选了不存在的目录：拒绝；非 Mac：回「只支持 Mac」不弹窗；缺 bot_id：拒绝不弹窗", async () => {
    const a = mk("a4", "A");
    const { file, cfg } = newCfg("s4", { bot_dirs: { "bot-a": a } });
    const before = readFileSync(file, "utf8");
    let asked = 0;
    const s = createSession(cfg, { log: quiet, platform: "darwin", file, pickDir: async () => { asked++; return asked === 1 ? null : path.join(base, "no-such-dir"); } });
    const c = collect();
    await s.onMessage({ type: "pick_dir", id: "p1", bot_id: "bot-a" }, c.send);
    await s.onMessage({ type: "pick_dir", id: "p2", bot_id: "bot-a" }, c.send);
    await s.onMessage({ type: "pick_dir", id: "p3" }, c.send);
    assert.deepEqual(c.out[0], { type: "dir_result", id: "p1", ok: false, bot_id: "bot-a", cancelled: true });
    assert.equal(c.out[1].ok, false);
    assert.match(c.out[1].error, /工作目录不存在/);
    assert.deepEqual(c.out[2], { type: "dir_result", id: "p3", ok: false, error: "缺 bot_id" });
    assert.equal(asked, 2);
    assert.deepEqual(s.botDirs, { "bot-a": a });
    assert.equal(readFileSync(file, "utf8"), before);
    let linAsked = 0;
    const lin = createSession(cfg, { log: quiet, platform: "linux", file, pickDir: async () => { linAsked++; return a; } });
    const c2 = collect();
    await lin.onMessage({ type: "pick_dir", id: "p4", bot_id: "bot-a" }, c2.send);
    assert.deepEqual(c2.out, [{ type: "dir_result", id: "p4", ok: false, bot_id: "bot-a", error: PICK_ONLY_MAC }]);
    assert.equal(linAsked, 0);
  });

  it("S8 R758：set_binding 空目录用固定共享资料库；自定义目录照写；调用带的冻结目录优先于当前目录", async () => {
    const a = mk("s8-a", "A 的文件"); const b = mk("s8-b", "B 的文件");
    const oldHome = process.env.AGENT_RUNNER_HOME;
    process.env.AGENT_RUNNER_HOME = path.join(base, "s8-home");
    try {
      const { file, cfg } = newCfg("s8");
      const s = createSession(cfg, { log: quiet, platform: "darwin", file });
      const c = collect();
      await s.onMessage({ type: "set_binding", id: "b1", bot_id: "bot-a", dir: null }, c.send);
      const lib = path.join(base, "s8-home", "library");
      assert.equal(c.out.at(-1).ok, true);
      assert.equal(c.out.at(-1).dir, lib);
      assert.equal(statSync(lib).isDirectory(), true);
      assert.deepEqual(botDirsOf(JSON.parse(readFileSync(file, "utf8"))), { "bot-a": lib });
      await s.onMessage({ type: "set_binding", id: "b2", bot_id: "bot-b", dir: b }, c.send);
      assert.deepEqual(s.botDirs, { "bot-a": lib, "bot-b": b });
      // 当前 bot-a 在资料库；调用显式带 A 的冻结目录，就用 A 的文件。
      const frozen = collect();
      await s.onMessage({ type: "call", id: "f1", op: "read", args: { path: "f.txt" }, bot_id: "bot-a", dir: a }, frozen.send);
      assert.equal(frozen.out.at(-1).text, "A 的文件");
    } finally {
      if (oldHome === undefined) delete process.env.AGENT_RUNNER_HOME; else process.env.AGENT_RUNNER_HOME = oldHome;
    }
  });

  it("S16 R773：remove_binding 只删这个 bot 的配置，保留其他绑定和真实目录", async () => {
    const a = mk("s16-a", "A 不能删"); const b = mk("s16-b", "B 不能删");
    const { file, cfg } = newCfg("s16", { bot_dirs: { "bot-a": a, "bot-b": b } });
    const s = createSession(cfg, { log: quiet, platform: "darwin", file });
    const c = collect();
    await s.onMessage({ type: "remove_binding", id: "r1", bot_id: "bot-a" }, c.send);
    assert.deepEqual(c.out, [{ type: "result", id: "r1", ok: true, bot_id: "bot-a" }]);
    assert.deepEqual(s.botDirs, { "bot-b": b });
    assert.deepEqual(botDirsOf(JSON.parse(readFileSync(file, "utf8"))), { "bot-b": b });
    assert.equal(readFileSync(path.join(a, "f.txt"), "utf8"), "A 不能删");
    assert.equal(readFileSync(path.join(b, "f.txt"), "utf8"), "B 不能删");
    await s.onMessage({ type: "remove_binding", id: "r2" }, c.send);
    assert.equal(c.out.at(-1).ok, false);
  });

  it("S5 服务器超时发 abort：弹窗被中止（窗口进程关掉），不回 dir_result，配置不变", async () => {
    const { file, cfg } = newCfg("s5");
    const before = readFileSync(file, "utf8");
    let aborted = false;
    const s = createSession(cfg, { log: quiet, platform: "darwin", file,
      pickDir: ({ signal }) => new Promise((_r, reject) => { signal.addEventListener("abort", () => { aborted = true; reject(Object.assign(new Error("已中止"), { name: "AbortError" })); }); }) });
    const c = collect();
    const p = s.onMessage({ type: "pick_dir", id: "p5", bot_id: "bot-a" }, c.send);
    s.onMessage({ type: "abort", id: "p5" }, c.send);
    await p;
    assert.equal(aborted, true);
    assert.deepEqual(c.out, []);
    assert.equal(readFileSync(file, "utf8"), before);
  });

  it("S6 正在跑的命令不受换目录影响：bash 开始时在 A 旧目录，跑的途中换了 A 的目录，它照样在旧目录里跑完", async () => {
    const a = mk("a6", "A 旧"); const a2 = mk("a6new", "A 新");
    const { file, cfg } = newCfg("s6", { bot_dirs: { "bot-a": a } });
    const s = createSession(cfg, { log: quiet, platform: "darwin", file, pickDir: picks(a2) });
    const c = collect();
    const run = s.onMessage({ type: "call", id: "b", op: "bash", args: { command: "sleep 0.3; pwd", timeout: 5 }, bot_id: "bot-a" }, c.send);
    await new Promise((r) => setTimeout(r, 50));
    await s.onMessage({ type: "pick_dir", id: "p", bot_id: "bot-a" }, () => {});
    await run;
    const out = c.out.filter((m) => m.type === "output").map((m) => Buffer.from(m.data, "base64").toString("utf8")).join("");
    assert.equal(out.trim(), a);
    assert.equal((await read(s, "bot-a", "f.txt")).text, "A 新");
  });

  // @意图#R716(2026-11-02): Windows 上也能选目录（不再直接回「只支持 Mac」）
  it("S7 win32 平台会去调弹窗（注入的），选完正常写回配置", async () => {
    const a = mk("a7", "A7 的文件");
    const { file, cfg } = newCfg("s7");
    let asked = 0;
    const s = createSession(cfg, { log: quiet, platform: "win32", file, pickDir: async () => { asked++; return a; } });
    const c = collect();
    await s.onMessage({ type: "pick_dir", id: "p7", bot_id: "bot-a" }, c.send);
    assert.equal(asked, 1);
    assert.deepEqual(c.out, [{ type: "dir_result", id: "p7", ok: true, bot_id: "bot-a", dir: a }]);
    assert.deepEqual(botDirsOf(JSON.parse(readFileSync(file, "utf8"))), { "bot-a": a });
  });
});
