// 在 Windows 的交互桌面会话里调 pickDirWindows（schtasks /it 起），60 秒没人点就自动中止。
// 结果写到同目录的 pick-result.txt。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pickDirWindows } from "./runner.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "pick-result.txt");
const ac = new AbortController();
const timer = setTimeout(() => ac.abort(), 60000);
try {
  const picked = await pickDirWindows({ signal: ac.signal });
  fs.writeFileSync(out, picked === null ? "cancelled" : `picked=${picked}`);
} catch (e) {
  fs.writeFileSync(out, `error=${e?.name}: ${e?.message}`);
} finally {
  clearTimeout(timer);
}
