<!-- @意图#R914(2026-11-21): 官方套餐最低运行器改为 0.12.0，登录代码来自 pi-ai 1.6.0 -->
<!-- @意图#R912(2026-11-20): 加「官方套餐（当时 0.11.0 起）」一节：四家登录、令牌只在本机、转发白名单、风控风险自担 -->
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
- **macOS / Windows**：给 bot 选自定义目录时会弹系统选文件夹窗口；macOS 和 Windows 都支持开机自启。
- bot 跑命令时 macOS / Linux 用 `bash`，Windows 用 PowerShell。

## 第一次连接

1. 在网页上打开某个 bot 的私聊，点输入框下面「我的电脑」那一行，右侧会打开抽屉，里面有一条命令。
2. 复制那条命令到终端运行，形如：

   ```bash
   npx -y agent-hub-runner@latest pair <配对码>@你的服务器地址
   ```

   配对码 5 分钟有效、只能用一次；过期了在抽屉里点「换一个码」。配对成功后直接连上。
3. Mac 上会问「开机自动连上？(Y/n)」：回车就是「是」，以后开机自己连上，终端可以关；选「否」的话终端窗口别关。
4. 抽屉里第 2 步会自动打勾。之后到网页右侧「bot设置 → 执行环境」给这个 bot 选电脑；默认使用这台电脑的共享资料库，需要时可点「选择自定义目录」在本机弹窗里选文件夹。

## 联网搜索（0.6.0 起）

- 服务器会把这次要用的搜索服务、key 或 SearXNG 地址临时发过来，运行器只在这一条请求里使用，不写进本机 `config.json`。
- 支持 DuckDuckGo、Tavily、Brave、SearXNG、DeepSeek、Kimi 开放平台、Kimi Code（`/coding/v1/search`）。
- 返回各家原始结果（`raw: true`），不再先压成标题/网址/摘要；服务器负责去掉重复网址、缓存正文和 `search_read`。
- 旧运行器（0.5.x 及更早）只认 DuckDuckGo、Tavily、Brave、SearXNG；服务器遇到 DeepSeek、Kimi、Kimi Code 会自动改走服务器侧，不会让旧运行器悄悄换成 DuckDuckGo。

## 多台电脑、共享资料库和整台电脑访问（0.5.0 起）

- 同一个账号可以连多台电脑；每台运行器有自己的配置和令牌。
- 每台电脑有一个**固定的共享资料库**：`~/.agent-runner/library`（Windows 是当前用户目录下的 `.agent-runner\library`）。程序自动创建，不能改成别的路径；升级、重启、自更新都不会清空。它是应用数据，不是临时缓存。
- bot 绑定这台电脑后默认就使用共享资料库；单个 bot 可以在网页 bot 设置里改成别的目录。
- 绑定后 bot 可以读写整台电脑，**不再限制在某个授权文件夹**；实际仍受运行器所在系统账号本身的权限限制。read 不弹批准，write/edit 自动允许并留记录，跑命令仍按「帮我批准命令行」决定是否要你点。只绑定你信任的电脑。
- 后台任务创建时冻结当时的电脑和目录；中途在网页切绑不影响旧任务，新消息和新任务用新绑定。

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

开机自启时，程序复制到 `~/.agent-runner/bin/<版本>/`，日志在 `~/.agent-runner/logs/runner.log`（超过 5MB 自动清空）。网页上提示「有新版本」时，**0.14.1 起**可以直接点「升级」。R839 查实 0.3.2～0.10.0 的网页入口调用了不存在的函数，这些已安装旧版要按提示手动运行一次升级命令；0.3.1 及更早本来就不认网页升级指令。R841 起强制弹窗和当前电脑的升级卡片始终保留「手动升级」入口，自动失败会自己展开命令，不再只给一个可能失效的按钮。R842 起 0.3.2～0.10.0 直接显示手动命令；自动升级断线时窗口保留进度，成功后才关闭。

**R977（2026-11-25）：0.10.1～0.13.x 的自动升级会把新副本装成残缺版**——它拿自己那份旧的 `COPY_FILES` 白名单去筛新包，把新版本新增的模块（`official.mjs`、`oauth.bundle.mjs`、`search-ops.mjs`）当垃圾删掉，新副本一启动就是 `ERR_MODULE_NOT_FOUND`，网页只能报「新版没接上」；更麻烦的是它先把 `bin/current` 指针换到那个残缺目录，**电脑一重启/重登就彻底连不上**。已在 0.14.1 修好：拷什么改读新包自己的 `package.json files`，指针等新版真拿到锁后才切。但**旧版代码在客户机上改不了**，所以服务端 `SELF_UPDATE_SINCE` 已抬到 `0.14.0`，0.10.1～0.13.x 一律只给手动命令（`npx -y agent-hub-runner@latest autostart on`，跑的是完整包，能正常装上）。已经看到失败提示的那台电脑，在跑这条命令前不要重启。

开发回归：`node --test test/self-update-process.test.mjs` 用真实 WebSocket 和新旧 CLI 进程验收当前版到动态下一版，前台支持 Mac/Linux，自启进程交接只在 Mac 跑；npm 和 launchctl 都是隔离假实现，不碰真实配置。

仓库开发者（R699）：要让仓库里的源码 `runner/runner.mjs` 直接连测试服、开机自启，用 `agent-hub/scripts/runner-test.sh autostart on|off | start | stop | status | log`（launchd 服务 `com.agenthub.runner.src`，日志 `~/.agent-runner/logs/runner-src.log`，不复制程序，改了代码 `start` 一下就生效）。普通用户不用管这个。

## 配置文件

- 默认在 `~/.agent-runner/config.json`（权限 600），里面有服务器地址、设备 id、长期令牌、电脑名和每个 bot 的工作目录。别发给别人。
- 共享资料库固定在同一应用目录下的 `library/`，不写进配置，也没有修改命令。
- 想放别处：设环境变量 `AGENT_RUNNER_CONFIG=/某个路径/config.json`。
- 文件坏了：删掉它，回网页拿新配对码重新配对。


## 项目上下文快照（0.3.0；`.claude/skills` 起 0.3.1）

服务器在每轮主对话开始时可能调用只读操作 `context_snapshot`（没有路径参数）：在**当前 bot 的默认工作目录**里读取一份 AGENTS/CLAUDE 规则，并列出 `.pi/skills`、`.agents/skills`、`.claude/skills` 下技能的名称与说明（不上传技能全文）。R758 起目录不再是权限边界，但项目规则仍只从默认工作目录开始找。基础快照需要运行器 **0.3.0+**；发现 `.claude/skills` 需要 **0.3.1+**。

## 常见问题

- `command not found: npx`：还没装 Node。
- 「需要 Node 22 或更新」（上面还有几行英文 `npm warn EBADENGINE`）：Node 太旧，装新的 LTS 版后关掉终端重开。
- 「权限不够」/ `EACCES`：别用 sudo；运行 `sudo chown -R "$(whoami)" ~/.npm ~/.agent-runner` 修好再试。
- 「找不到服务器」「连不上服务器」「超时」：检查网络；命令要整条原样复制。
- 「配对码过期了 / 已经用过了 / 已经作废了」：网页上点「换一个码」再运行新命令。
- 「这个账号已经连着一台电脑了」：这是旧版提示；0.5.0 起一个账号可以连多台，旧版可以升级后再配。
- 想再加一台电脑：网页「我的电脑」抽屉里点「添加电脑」，拿新码到另一台电脑运行。
- 开机自启报「Bootstrap failed: 5: Input/output error」：这个后台任务以前被 macOS 记成了「已禁用」。0.2.1 起 `autostart on` 会自己解除并重试，直接再运行一次 `npx -y agent-hub-runner@latest autostart on` 就行；还不行就按它给的那条 `launchctl enable …` 命令运行后再试，或重启电脑再试。
- 升级后网页还说「运行器版本太旧」：旧版本的运行器还在后台跑着（升级前开的终端，或者旧的开机自启），新版一看有人连着就退出了。0.2.2 起新版会自己把旧版本停掉、接上服务器；从 0.2.1 或更早升上来的，运行一次 `npx -y agent-hub-runner@latest autostart on` 就行，它会先停掉正在跑的那个，等新版本真连上了才说「已设开机自启」。
- 网页上点「升级」（0.10.1 起）：抽屉里有新版本时点一下，运行器自己去 npm 拉最新版、校验后换上并重启，不用开终端。Mac / Windows 开机自启的换装由独立新版进程执行，不会在 `bootout` / 停计划任务时把升级进程自己杀掉。0.3.2～0.10.0 的网页入口有缺陷，0.3.1 及更早不认这个按钮，都要用上面那条命令手动升一次。
- 联网搜索（0.4.0 起）：bot 设置里打开「允许联网搜索」后，bot 可以上网查资料。默认用 DuckDuckGo，不用注册、不用 key。想更稳可以在「我的电脑」抽屉里换成 Tavily 或 Brave（去官网注册，把 key 粘进来），或者填一个 SearXNG 地址。key 只存在你电脑上，服务器不留。0.3.x 及更早没有这项，抽屉里会给升级命令。
- 共享资料库和整台电脑访问需要 **0.5.0**；旧运行器仍能连接，但不知道默认资料库，也不会按新规则放开目录。

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
- 卸载：删掉 `~/.agent-runner/browser`、`~/.agent-runner/browsers`、`~/.agent-runner/browser-profiles` 三个文件夹；录像也要删时，再删 `~/.agent-runner/recordings`。

### 浏览器录像（0.9.0 起）

- **A：录当前 bot 浏览器**：AI 用 `browser(record_start)` 开始、继续操作、`browser(record_stop)` 停止，得到本机 MP4。可选 `path`（绝对路径）、`fps`（默认 10）、`max_seconds`（默认 60，最长 180）、`show_cursor`。默认文件在 `~/.agent-runner/recordings/<botId>/`。关闭浏览器或切换窗口模式会先保存；录制中不能切标签页。
- **B：独立标签页录像**：AI 在一次性测试脚本里导入 `runner/tab-recorder.mjs` 的 `withTabRecorder`，适合自动测试线上网页或网页游戏。`audio:true` 可录标签页声音，`showCursor:true` 可显示网页指针，`output` 支持 `.webm` / `.mp4`。测试脚本先打开页面、点击开始并等声音/画面准备好，再调用 `start()`，避免录进缓冲。
- B 使用独立 Chromium 和新 BrowserContext，不读当前 bot 的登录资料；自动接受标签页采集的启动参数只给这只测试浏览器。录制中刷新或跳转可能中断，需要分段，不会假装完整成功。
- 网页指针是录制期间注入的辅助圆点，只跟网页内指针，不是系统光标，也不拦截点击。A 不含音频；B 录的是标签页声音，不是麦克风或整个电脑的系统声音。
- A 和 B 输出 MP4 都需要本机 ffmpeg；找不到时明确报错，不自动安装。可用 `AGENT_HUB_FFMPEG` 指定路径。B 输出 WebM 不需要 ffmpeg。录像默认只存本机；要发给客户时由 AI 另行显式调用 `send_files`，不会自动上传。AI 要检查内容时按需自行抽帧。

```js
import { withTabRecorder } from "./runner/tab-recorder.mjs";

await withTabRecorder({ output: "game.mp4", audio: true }, async ({ page, start }) => {
  await page.goto("https://example.com/game");
  await page.click("#start");
  await start();
  // 自动测试与断言……
});
```

## bot 发文件给客户（0.10.0 起）

- AI 在当前私聊调用 `send_files({paths, text?})`，可把这台电脑上的 1～20 个文件/图片作为一条消息发给客户；不能发群。相对路径按当前 bot 工作目录解析，绝对路径按本机实际位置读取。
- 运行器收到 `file_upload` 后，用服务器给的一次性短时票据进行 HTTP 流式上传；文件内容不经过 WebSocket Base64。票据只能用于当前这批文件，不能长期随便上传。
- 单文件最多 200 MB、图片 32 MB、整批 500 MB；目录、空文件、超限会在本机提前拒绝。上传期间停止或断线会中止，原文件不改变。服务器保存 30 天，失败批次会清理未使用附件。
- 0.9.x 及更早没有 `file_upload`，服务器会明确提示升级，不会静默等待。

## 官方套餐（0.12.0 起）

- 网页「设置 → 我的模型」里每台电脑一张卡片，可以给这台电脑登录 **Kimi Code 会员、Grok（xAI 订阅）、GitHub Copilot、ChatGPT（Codex）** 四家官方套餐（没有 Anthropic、Gemini）。点「登录」后网页显示设备码链接和确认码（Codex 显示登录链接；浏览器不在这台电脑上时，把回调地址粘贴回网页），在那边同意就行。
- **令牌只存在这台电脑上**（配置文件 `official` 一节，文件权限 600），服务器上没有。bot 用官方套餐时，服务器把请求（带占位凭据）经 WebSocket 交给**这一轮绑定的那台电脑**，运行器去掉服务器带的认证头、换上真令牌、把指纹头改成官方客户端的样子再发出去，回复按小段原样传回。
- 只转发到四家官方的固定域名（白名单），别的地址一律拒绝。快过期时自动刷新（同一家同时只刷一次，刷完立刻写回配置文件）。网页上叫停会同时停掉电脑这头的请求。
- 电脑不在线时 bot 用不了这台电脑的官方套餐（「电脑不在线，用不了这个套餐」），**不会**改用别的电脑或别的 key。运行器低于 0.12.0 没有当前这套官方套餐能力，网页会提示升级。
- 退出：网页点「退出」，运行器删掉本机令牌。
- 登录代码来自 pi-ai 1.6.0（MIT，© Mario Zechner），打包成 `oauth.bundle.mjs` 随包发布，运行器仍然没有第三方依赖。
- **风险**：用官方订阅套餐跑 bot 可能触发对方的账号风控（限流、封号等），后果由你自己承担。

## 安全提示

- 别把放着密钥、令牌的文件夹授权出去：bot 在授权文件夹里读、写、改文件不用你批准。
- 跑命令前网页上会弹批准卡片，看清命令再点「允许一次」；命令本身能碰到文件夹以外的东西（没有沙箱）。
- bot 用浏览器不弹批准卡片，能打开任何网址；在 bot 的浏览器里登录过的网站，bot 都能以你的身份操作。别在里面登录你不想让 bot 碰的账号（网银、支付等）。
