#!/usr/bin/env node
// @意图#R664(2026-10-29): npm 包 agent-hub-runner 的命令入口（package.json 的 bin）：客户电脑 npm i -g agent-hub-runner 后直接跑
// agent-hub-runner pair <配对码> --start --server <地址> / start / status；逻辑全在 ../runner.mjs，这里只把参数和命令名交过去。
// @意图#R666(2026-10-29): 主要用法改成 npx -y agent-hub-runner@latest pair 码@地址；最先查 Node 版本（在加载别的代码之前，老 Node 上也只打一句大白话，
// 说明上面 npm 的英文 EBADENGINE 警告不用管）；出错用 explainError 打大白话（权限不够单独说）
const major = Number(process.versions.node.split(".")[0]);
if (major < 22 || typeof WebSocket === "undefined") {
  console.error(`需要 Node 22 或更新，你这台电脑上是 ${process.versions.node}。\n（上面如果有几行英文 npm warn EBADENGINE，说的就是这个，不用管它。）\n去 https://nodejs.org 下载 LTS 版装上（Mac 选 .pkg 安装包），装好后关掉终端重新打开，再运行同一条命令。`);
  process.exit(1);
}
const { main, progName, explainError } = await import("../runner.mjs");
main(process.argv.slice(2), progName()).catch((e) => { console.error(explainError(e)); process.exit(1); });
