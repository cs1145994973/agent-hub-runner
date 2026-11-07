<!-- @意图#R747(2026-11-06): 说明 .claude/skills 需运行器 0.3.1 -->
<!-- @意图#R745(2026-11-06): 说明 context_snapshot / 0.3.0 -->
<!-- @意图#R729(2026-11-04): 加 browser install / status 和「bot 的浏览器」一节（0.2.0） -->
<!-- @意图#R690(2026-11-01): 加「改动记录」一节：存在哪、打码、64 KB、30 天、怎么删 -->
<!-- @意图#R732(2026-11-04): 常见问题加「升级了网页还说版本太旧」（0.2.2 起新版自动顶掉旧进程） -->
<!-- @意图#R731(2026-11-04): 常见问题加开机自启「Bootstrap failed: 5」（0.2.1 起自动处理） -->
<!-- @意图#R666(2026-10-29): 改成不用全局安装的 npx 一条命令（码@地址）、Mac 开机自启、stop / uninstall、常见报错 -->
<!-- @意图#R664(2026-10-29): npm 包 agent-hub-runner 的说明（随包发布）：给客户看的安装、配对、再连、查看、断开、卸载和安全提示 -->
# agent-hub-runner

agent-hub 的电脑运行器。装在你自己的电脑上，配对之后，你的 bot 就能在你给它选的文件夹里读、写、改文件，跑命令（跑命令每次都要你在网页上点批准）。

- 没有第三方依赖，只用 Node 自带的功能。不用先装：用 `npx` 直接运行。
- Mac 上可以设成开机自动连上（在后台跑，不用开终端）；不设的话在终端前台跑，按 Ctrl-C 断开。

## 需要

- **Node 22 或更新**（终端里运行 `node -v` 看版本）。还没装：去 [nodejs.org](https://nodejs.org) 下载 LTS 版（Mac 选 .pkg 安装包），或者 `brew install node`。
- **macOS**：给 bot 选目录时会在 Mac 上弹出系统的「选文件夹」窗口；开机自启也只支持 Mac。别的系统能连上，但选不了目录。
- bot 跑命令时用 `bash`（macOS、Linux 自带）。

## 第一次连接

1. 在网页上打开某个 bot 的私聊，点输入框下面「我的电脑」那一行，右侧会打开抽屉，里面有一条命令。
2. 复制那条命令到终端运行，形如：

   ```bash
   npx -y agent-hub-runner@latest pair <配对码>@你的服务器地址
   ```

   配对码 5 分钟有效、只能用一次；过期了在抽屉里点「换一个码」。配对成功后直接连上。
3. Mac 上会问「开机自动连上？(Y/n)」：回车就是「是」，以后开机自己连上，终端可以关；选「否」的话终端窗口别关。
4. 抽屉里第 2 步会自动打勾。第 3 步点「选择目录…」，在 Mac 弹出的窗口里选这个 bot 能用的文件夹。每个 bot 各选各的。

`@` 后面的地址默认是 https；`localhost`、`127.x` 默认 http；也可以写全 `码@http://…`。老写法 `pair <配对码> --server <地址>` 照样能用。只配对不连：加 `--no-start`。

## 以后再连

开了开机自启的不用管。没开的，重启电脑或关了终端之后运行：

```bash
npx -y agent-hub-runner@latest start
```

服务器地址和令牌配对时已经存下了，不用再给。后台已经连着时再 `start` 会说「已经在后台连着，不用再开」。

## 其他命令

```bash
npx -y agent-hub-runner@latest status          # 版本、连的哪个服务器、在不在跑、开机自启、每个 bot 的目录
npx -y agent-hub-runner@latest autostart on    # 开机自动连上（Mac）；升级到新版也用这条
npx -y agent-hub-runner@latest autostart off   # 关掉开机自启
npx -y agent-hub-runner@latest autostart status
npx -y agent-hub-runner@latest stop            # 停掉在跑的运行器（开机自启的下次开机还会起）
npx -y agent-hub-runner@latest uninstall       # 关掉开机自启、删掉复制的程序；会问要不要删配置
npx -y agent-hub-runner@latest browser install # 给 bot 装它自己的浏览器（0.2.0 起，约 200MB，只要一次）
npx -y agent-hub-runner@latest browser status  # 看浏览器装没装
```

开机自启时，程序复制到 `~/.agent-runner/bin/<版本>/`，日志在 `~/.agent-runner/logs/runner.log`（超过 5MB 自动清空）。网页上提示「有新版本」时，按提示运行那一条升级命令。

仓库开发者（R699）：要让仓库里的源码 `runner/runner.mjs` 直接连测试服、开机自启，用 `agent-hub/scripts/runner-test.sh autostart on|off | start | stop | status | log`（launchd 服务 `com.agenthub.runner.src`，日志 `~/.agent-runner/logs/runner-src.log`，不复制程序，改了代码 `start` 一下就生效）。普通用户不用管这个。

## 配置文件

- 默认在 `~/.agent-runner/config.json`（权限 600），里面有服务器地址、设备 id、长期令牌、电脑名和每个 bot 的目录。别发给别人。
- 想放别处：设环境变量 `AGENT_RUNNER_CONFIG=/某个路径/config.json`。
- 文件坏了：删掉它，回网页拿新配对码重新配对。


## 项目上下文快照（0.3.0；`.claude/skills` 起 0.3.1）

服务器在每轮主对话开始时可能调用只读操作 `context_snapshot`（没有路径参数）：在**当前 bot 的授权文件夹根**里读取一份 AGENTS/CLAUDE 规则，并列出 `.pi/skills`、`.agents/skills`、`.claude/skills` 下技能的名称与说明（不上传技能全文）。目录外路径和越界符号链接一律拒绝。基础快照需要运行器 **0.3.0+**；发现 `.claude/skills` 需要 **0.3.1+**。

## 常见问题

- `command not found: npx`：还没装 Node。
- 「需要 Node 22 或更新」（上面还有几行英文 `npm warn EBADENGINE`）：Node 太旧，装新的 LTS 版后关掉终端重开。
- 「权限不够」/ `EACCES`：别用 sudo；运行 `sudo chown -R "$(whoami)" ~/.npm ~/.agent-runner` 修好再试。
- 「找不到服务器」「连不上服务器」「超时」：检查网络；命令要整条原样复制。
- 「配对码过期了 / 已经用过了 / 已经作废了」：网页上点「换一个码」再运行新命令。
- 「这个账号已经连着一台电脑了」：一个账号同时只能连一台，先在网页抽屉「连着的电脑」里点「断开」。
- 开机自启报「Bootstrap failed: 5: Input/output error」：这个后台任务以前被 macOS 记成了「已禁用」。0.2.1 起 `autostart on` 会自己解除并重试，直接再运行一次 `npx -y agent-hub-runner@latest autostart on` 就行；还不行就按它给的那条 `launchctl enable …` 命令运行后再试，或重启电脑再试。
- 升级后网页还说「运行器版本太旧」：旧版本的运行器还在后台跑着（升级前开的终端，或者旧的开机自启），新版一看有人连着就退出了。0.2.2 起新版会自己把旧版本停掉、接上服务器；从 0.2.1 或更早升上来的，运行一次 `npx -y agent-hub-runner@latest autostart on` 就行，它会先停掉正在跑的那个，等新版本真连上了才说「已设开机自启」。
- 网页上点「升级」（0.3.2 起）：抽屉里有新版本时点一下，运行器自己去 npm 拉最新版、校验后换上并重启，不用开终端。0.3.1 及更早不认这个按钮，仍用上面那条命令升一次。

## 断开、卸载

- 在网页抽屉「连着的电脑」里点「断开」：令牌立刻作废，再连要重新配对；开机自启也会自己关掉。
- 卸载：`npx -y agent-hub-runner@latest uninstall`（加 `--purge` 连配置一起删，不再问）。

## 改动记录（0.1.2 起）

- bot 每次写文件、改文件，运行器在配置文件旁边的 `edits/` 文件夹（默认 `~/.agent-runner/edits/`，只有你能读）存一份改动记录，网页上点「已改文件 / 已写文件（自动允许）」那行灰字就能看到改了什么。内容只在你电脑上，服务器不存。
- 存之前会把像密钥的字符串换成 `***`（`sk-…`、`ghp_…`、连接串里的密码、私钥、`XXX_KEY=…` 这类赋值）；每条最多 64 KB；只留 30 天，过期自动删。电脑不在线时网页上看不到。
- 不想留：直接删掉 `edits/` 文件夹，不影响别的。

## bot 的浏览器（0.2.0 起）

- bot 能在你电脑上用一只**它自己的浏览器**（独立的 Chromium，不碰你平时用的浏览器）。先运行一次 `npx -y agent-hub-runner@latest browser install`：装到 `~/.agent-runner/browser/`（playwright-core）和 `~/.agent-runner/browsers/`（Chromium）。先走官方源，下不动会自动换国内镜像（npmmirror）。装好不用重启运行器。
- 每个 bot 一个资料目录 `~/.agent-runner/browser-profiles/<bot>/`，登录状态会保存。平时在后台（没有窗口）跑，闲 10 分钟自动关。
- 要登录、扫码、过验证码：在网页「我的电脑」抽屉里点「打开 bot 的浏览器」，会弹出这个 bot 的浏览器窗口，你弄好后直接关掉窗口，bot 接着在后台用。
- 不想让 bot 用浏览器：网页右栏「bot设置」里取消勾「允许用浏览器」。想清掉登录状态：删掉那个 bot 的资料目录。
- 卸载：删掉 `~/.agent-runner/browser`、`~/.agent-runner/browsers`、`~/.agent-runner/browser-profiles` 三个文件夹。

## 安全提示

- 别把放着密钥、令牌的文件夹授权出去：bot 在授权文件夹里读、写、改文件不用你批准。
- 跑命令前网页上会弹批准卡片，看清命令再点「允许一次」；命令本身能碰到文件夹以外的东西（没有沙箱）。
- bot 用浏览器不弹批准卡片，能打开任何网址；在 bot 的浏览器里登录过的网站，bot 都能以你的身份操作。别在里面登录你不想让 bot 碰的账号（网银、支付等）。
