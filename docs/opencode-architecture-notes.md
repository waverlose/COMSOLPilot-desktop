# OpenCode Desktop 架构调研与本项目对照

> 调研时间：2026-09-25
> 动机：本工程同时维护 Tauri 与 Electron 两套外壳，需要知道同类开源项目
> （尤其是「桌面壳 + 本地 HTTP 后端」这一形态）是怎么取舍和落地的。

调研对象是 [OpenCode](https://github.com/anomalyco/opencode)（SST 出品的 AI 编码代理）
的 Desktop 端。它与本工程的形态高度同构：**一个 web UI + 一个必须跑在本地进程里的
HTTP 服务端 + 一层原生外壳**。所以它的踩坑记录对我们是可直接复用的。

---

## 1. 最重要的结论：他们从 Tauri 迁回了 Electron

OpenCode 团队在 2026-04-19 发了一篇官方说明
[《Moving OpenCode Desktop to Electron》](https://dev.to/brendonovich/moving-opencode-desktop-to-electron-4hip)
（作者 Brendonovich），宣布桌面端改用 Electron 重写、即将停止发布 Tauri 版本。

原文开头就点明这不是「谁更快」的问题，而是**适配度**问题：

> This wasn't a decision we made lightly, and it has nothing to do with either Tauri or
> Electron being innately "better" or "faster" - Electron is simply a better fit for our use case.

### 三条理由（原文）

**① WebKit 渲染不一致，且性能更差**

> Tauri uses WebKit on macOS and Linux, which not only has worse performance than Chromium
> when rendering our app, but also has minor inconsistencies with it, especially around styles.
> This directly impacts our ability to ship a consistent experience across all platforms, and
> the reduced performance makes the app less pleasant to use day to day.

（作者还补了一句：Tauri 有 CEF 路线图，但「when that will be stable remains uncertain」。）

**② 打包 CLI 拖慢启动，且在 Windows 上偶发失败**

> The second problem was running the CLI - it impacted startup time, and occasionally just
> failed (despite @LukeParkerDev's best efforts on Windows).

**③ 想从 Bun 换到 Node —— Electron 自带 Node 进程，服务端代码可以直接跑**

> ...once combined with our desire to move from Bun to Node (for other reasons), the idea of
> simply running our server code within Electron's built-in Node process was quite appealing.

### 作者对常见质疑的回应（值得记住）

> Getting the best performance out of Tauri requires implementing your app's logic in Rust -
> Tauri itself is little more than a Rust library for launching and communicating with webviews.

> OpenCode is all written in TypeScript though, so the server needs to run in a Node/Bun process
> regardless. Any Rust we did use in Desktop wasn't going to move the needle on performance
> unless we rewrote the entire core and server.

> Doesn't Electron produce larger app bundles than Tauri? — Yeah, it's a trade-off we're
> willing to make.

### 这三条理由对本工程**都不成立**

这是本次调研最需要说清楚的一点：**不能因为 OpenCode 迁回 Electron 就认为
Tauri 对本项目也是错误选择**。逐条对照：

| OpenCode 的理由 | 对本工程是否成立 | 原因 |
| --- | --- | --- |
| ① WebKit 渲染不一致、性能差 | **不成立** | 本项目 Windows-only（COMSOL 只有 Windows 版）。Tauri 在 Windows 用 **WebView2**，内核就是 Chromium，与 Electron 同源，不存在渲染差异 |
| ② 打包 CLI 拖慢启动、Windows 偶发失败 | **不成立** | 我们的 sidecar 是 Python，**无论用哪个外壳都必须是外部进程**，与「是否把 CLI 塞进安装包」无关 |
| ③ 想从 Bun 换到 Node，用 Electron 自带 Node 跑服务端 | **不成立** | 后端是 Python，Electron 内置的 Node 帮不上任何忙；`utilityProcess.fork()` 也 fork 不了 `.py` |

作者自己的一句话正好解释了差异所在：

> OpenCode is all written in TypeScript though, so the server needs to run in a
> Node/Bun process regardless.

他们的服务端**注定是 Node**，所以「让 Electron 自带 Node 来跑」是顺水推舟；
我们的服务端**注定是 Python**，这个便宜我们占不到。

**结论：「两套外壳都保留」这个决定站得住**，不必因为这篇文就砍掉 Tauri。
但有一条真正可迁移的教训：**渲染一致性只在真要跨平台时才值钱**。
本项目 Windows-only，所以双外壳的风险不是「两个平台长得不一样」，
而是「两套窗口代码要同步维护」——这是纯维护成本，需要靠纪律而非技术解决。

> 另一个结构性差异要记住：OpenCode 全栈 TypeScript，所以能用
> `utilityProcess.fork()` 把服务端跑在 Electron 自带的 Node 里。
> **我们后端是 Python，用不了 utilityProcess**，只能 `child_process.spawn`。
> 这是本项目与它最大的实现差异，**不要照抄它的 sidecar 启动方式**。

---

## 2. OpenCode 的实际架构

### 2.1 进程与分层

```
┌─ Electron 主进程 (packages/desktop/src/main/) ──────────────────┐
│  index.ts          应用初始化 / 生命周期 / 单实例锁 / 协议注册     │
│  server.ts         sidecar 的 fork、就绪握手、健康检查、停止      │
│  windows.ts        窗口创建、无边框标题栏、状态持久化             │
│  ipc.ts            生命周期/窗口/设置/updater 的 IPC handlers     │
│  logging.ts        electron-log 初始化 + netlog                  │
│  updater*.ts       electron-updater 状态机                       │
│  unresponsive.ts   窗口无响应时采样 JS 调用栈                     │
└────────────────────────────────────────────────────────────────┘
          │ utilityProcess.fork("sidecar.js")
          │ postMessage({type:"start", hostname, port, password, userDataPath})
          ▼
┌─ Sidecar（Node utility process）────────────────────────────────┐
│  sidecar.ts   读 start 命令 → ensureLoopbackNoProxy() →          │
│               import("virtual:opencode-server") → Server.listen  │
│               → parentPort.postMessage({type:"ready"})           │
└────────────────────────────────────────────────────────────────┘
          │ HTTP + SSE，Basic Auth，只绑 127.0.0.1
          ▼
┌─ Renderer（packages/desktop/src/renderer/）─────────────────────┐
│  加载自 oc://renderer，通过 window.api 拿 {url, username, password}│
│  UI 本体在 packages/app（与 Web 版共享），靠 Platform 抽象解耦     │
└────────────────────────────────────────────────────────────────┘
```

`packages/app` 是与 Web 版共享的前端，通过 `src/context/platform.tsx` 里定义的
`Platform` 接口访问原生能力（文件选择器、通知、存储、全屏状态、WSL 管理……），
Electron 侧在 `renderer/index.tsx` 里把 `window.api`（preload 暴露）绑定到该接口。

> **对照本工程**：这就是我们 `src/lib/shell.ts` 的角色——「前端只调语义化函数，
> 不直接碰外壳 API」。我们做得更轻（一个模块而非接口 + 多实现），但思路一致。

### 2.2 关键常量与实现细节

以下分两类标注来源：**【源码】**= 直接读了 `packages/desktop/src/main/server.ts`
原文确认；**【二手】**= 来自 opendeep.wiki / deepwiki 的引用，未逐字读源码。

| 关注点 | 实现 | 来源 |
| --- | --- | --- |
| sidecar 进程类型 | `utilityProcess.fork(sidecar.js, [], { serviceName: "opencode server", stdio: "pipe" })` | 【源码】 |
| 就绪握手 | sidecar `postMessage({type:"ready"})`；主进程等消息，`ready` 才 resolve | 【源码】 |
| 启动停滞超时 | `SIDECAR_START_STALL_TIMEOUT = 60_000`，超时抛 `Sidecar did not become ready within 60000ms` | 【源码】 |
| 停止 | 先 `postMessage({type:"stop"})` 优雅停，`SIDECAR_STOP_TIMEOUT = 6_000` 后 `child.kill()` | 【源码】 |
| 健康检查 | 依次试 `GET /api/health`、`GET /global/health`，单次 `AbortSignal.timeout(3000)`，**100 ms 间隔轮询** | 【源码】 |
| 崩溃检测 | `app.on("child-process-gone")` 过滤 `details.type === "Utility" && details.name === SERVICE_NAME`，把 reason/exitCode 写日志 | 【源码】 |
| 子进程环境 | `createSidecarEnv()` 复制父环境后 **删掉 `DEBUG`**，Linux 上再删 `LD_PRELOAD` | 【源码】 |
| 端口分配 | 先读 `OPENCODE_PORT` 环境变量；否则 `listen(0,"127.0.0.1")` → 读 OS 分配的端口 → `close()` → 把端口交给 sidecar | 【二手】 |
| 认证 | HTTP **Basic Auth**，用户名固定 `"opencode"`，密码 `randomUUID()`；主进程健康检查也带这个头 | 【二手】 |
| 渲染协议 | 自定义 `oc://renderer`（`registerRendererProtocol()`，含 `rel.startsWith("..")` 路径穿越防护） | 【二手】 |
| CORS | `Server.listen({ cors: ["oc://renderer"] })` —— 精确 origin，非通配 | 【二手】 |
| 代理排除 | `ensureLoopbackNoProxy()` 把 `127.0.0.1`/`localhost`/`::1` 追加进 `NO_PROXY` 与 `no_proxy`；Chromium 侧配 `proxy-bypass-list` | 【二手】 |
| 日志 | `electron-log` → `<userData>/logs/<timestamp>/{main,server,utility,renderer,...}.log`；单文件 5 MB；保留 7 天；`network.netlog` 上限 20 MB | 【二手】 |
| 自动更新 | `electron-updater`，禁自动下载/禁退出时自动安装，channel `latest`；IPC `updater-check` / `updater-install` / `updater-subscribe` | 【二手】 |
| 窗口 | macOS/Windows 无边框 + 隐藏标题栏，但**保留原生控制按钮**；`setTitlebar()`/`updateTitlebar()`；状态经 `electron-window-state` + `window-registry` 持久化 | 【二手】 |
| 单实例 | 每用户会话一个实例 | 【二手】 |
| 版本 | Electron 41 / Node 24 | 【二手】 |

---

## 3. 逐项对照本工程

✅ = 已经一致（独立收敛到同一方案）
⚠️ = 我们有、但比它弱
❌ = 我们缺

| 关注点 | OpenCode | 本工程 | |
| --- | --- | --- | --- |
| 端口分配 | bind `127.0.0.1:0` → 读端口 → close → 交接 | `pickPort()`：`createServer().listen(0,"127.0.0.1")` → 读端口 → `close()` | ✅ |
| 渲染协议 | `oc://renderer` | `app://localhost`（`registerSchemesAsPrivileged` + `protocol.handle`） | ✅ |
| 路径穿越防护 | `rel.startsWith("..") \|\| isAbsolute(rel)` | `target.startsWith(distRoot + path.sep)` | ✅ |
| 渲染进程取连接信息 | IPC `await-initialization` → `{url, username, password}` | IPC `backend:port` + `backend:token` | ✅ |
| 前端外壳抽象 | `packages/app` + `Platform` 接口 | `src/lib/shell.ts` | ✅ |
| 单实例锁 | ✅ | `app.requestSingleInstanceLock()` | ✅ |
| 无边框窗口 + 自绘标题栏 | ✅（但保留原生按钮） | ✅（全自绘按钮） | 差异，各自合理 |
| **sidecar 进程类型** | `utilityProcess.fork()` | `child_process.spawn()` | ❌ |
| **就绪握手** | 消息级 `ready` | 无——主进程不知道后端起没起 | ❌ |
| **启动停滞超时** | 60 s | 无 | ❌ |
| **优雅停止 + 超时强杀** | `postMessage({stop})` → 6 s → kill | 直接 `child.kill()`（**没用上已有的 `/api/shutdown`**） | ❌ |
| **回环代理排除** | `ensureLoopbackNoProxy()` | 无 | ❌（本机已因代理踩过坑） |
| **日志落盘** | `<userData>/logs/<ts>/`，7 天保留 | 仅内存缓冲 + 渲染进程日志页，**重启即丢** | ❌ |
| **CORS 精确性** | 只放行 `oc://renderer` | 正则放行**任意 localhost 端口** + tauri/app | ⚠️ |
| 自动更新 | electron-updater | 无 | ❌（打包后再做） |
| 窗口状态持久化 | 有 | 无（固定 1080×720） | ❌ |
| 崩溃原因上报 | `child-process-gone` 带 reason/exitCode | 只有 `exit` 的 code/signal | ⚠️ |
| 子进程环境净化 | 删 `DEBUG` / `LD_PRELOAD` | 只追加 `PYTHONUTF8`/`PYTHONIOENCODING` | ⚠️ |

---

## 4. 建议照抄的部分（按性价比排序）

### P0 —— 便宜、且能直接消除已知痛点

**4.1 `ensureLoopbackNoProxy()`**

把 `127.0.0.1` / `localhost` / `::1` 追加进 `NO_PROXY` 与 `no_proxy`。

本工程已经**实际踩过这个坑**：`loadFrontend()` 最初用 `net.fetch` 探 vite 死活，
被系统代理拦成 502 而挂住，最后被迫改成裸 TCP 连接。同样的风险还在别处：
主进程若要用 HTTP 探 sidecar 健康状态、Electron 自身的网络栈若被要求走代理，
都会再次中招。约 15 行代码，收益明确。

**4.2 用上已有的 `/api/shutdown`**

`python-sidecar/sidecar_server.py` 已经实现了 `/api/shutdown`（置
`uvicorn.Server.should_exit = True`），但 Electron 的 `stopSidecar()` 只做
`child.kill()`，**这个接口从来没被调用过**。Windows 上 `kill()` 对 Python 进程
未必干净，容易留孤儿进程或让 uvicorn 来不及 flush 日志。
应改为：先 POST `/api/shutdown` → 等 5-6 秒 → 仍在则强杀。

**4.3 启动停滞超时**

后端起不来时，目前界面表现为「一直转圈 / 后端连不上」，用户拿不到结论。
加一个 60 秒兜底，超时后把「后端在 60 秒内未就绪，请看日志」推到日志页和状态栏。

### P1 —— 结构性改进

**4.4 就绪握手：把「主进程知道后端起没起」变成一等公民**

现状是前端自己轮询 `/api/state`，主进程对 sidecar 状态一无所知。
改成 OpenCode 的两层模型：

- 主进程启动后**轮询** `GET /api/health`（单次 3 s 超时，100-250 ms 间隔），
  就绪后通过 IPC 广播 `backend:ready`；
- 前端订阅该事件，不再自己盲轮询。

顺带解决一个现存问题：`POST /api/server/start` 要 30-60 秒才真的起来，
现在靠前端轮询 `starting: true`；有了统一就绪通道后可以合并成一条状态流。

**4.5 sidecar 换成 `utilityProcess.fork()`（仅 Electron 侧）—— 实测不建议**

先说结论：**这条不值得抄**，列在这里是为了防止后人看到 OpenCode 的写法就照搬。

`utilityProcess` 只能 fork **Node/JS 入口**，而我们的 sidecar 是 Python 脚本。
要用它就必须再写一个几行的 JS 启动器（`utilityProcess.fork("launcher.js")`
由它去 `spawn` Python），凭空多一层进程转发，而换来的好处很有限：

| 想要的好处 | 用现有 `spawn` 能否拿到 |
| --- | --- |
| 崩溃时知道原因 | ✅ `app.on("child-process-gone")` 对 `child_process.spawn` 出来的子进程同样会触发 |
| 父进程退出时子进程被回收 | ✅ `before-quit` / `will-quit` 里已有 `stopSidecar()`，配合 4.2 的优雅停止即可 |
| `stdio: "pipe"` 语义一致 | ✅ 已经在用 |
| `serviceName` 便于在事件里识别 | ⚠️ 这条拿不到，但可以用 pid 匹配替代 |

**建议：维持 `child_process.spawn`，只补 4.2/4.3 两件事。**

**4.6 日志落盘**

`<userData>/logs/<timestamp>/{main,sidecar}.log`，单文件 5 MB、保留 7 天。
对桌面软件是刚需——用户报「用不了」时，唯一能拿到证据的途径。
本项目已有 `electron-log` 的替代品吗？没有，但 `electron-log` 可以直接装。

### P2 —— 打包阶段再做

**4.7 `electron-updater` 自动更新**（禁自动下载、退出时不自装，让用户确认）。
**4.8 窗口尺寸/位置持久化**（`electron-window-state`）。
**4.9 CORS 收紧**：打包态把 `ALLOWED_ORIGIN_REGEX` 里的
`https?://(localhost|127.0.0.1)(:\d+)?` 分支去掉，只留 `tauri://localhost` 与
`app://localhost`。开发态需要放行 vite 端口，可以按 `paths.is_frozen()` 之类
的运行态开关切换，而不是一直全开。

---

## 5. 不要照抄的

- **WSL 支持**（`createWslServersController`）——COMSOL 是 Windows 原生商业软件，
  没有 WSL 场景。
- **Bun 插件兼容处理**——我们后端是 Python。
- **「迁移到 Electron、放弃 Tauri」这个结论本身**——他们的理由是技术栈全在 TS、
  不需要 Rust 加速；我们的情况是「Rust 外壳零业务逻辑」，所以 Tauri 版对我们是
  纯冗余成本，但**双外壳并存是用户明确要求**，保留即可，不必因为这篇文就砍掉。
- **`virtual:opencode-server` 虚拟模块注入**——那是为了把服务端代码塞进
  Rollup 打包，我们的后端是独立 Python 目录，天然隔离，不需要。

---

## 6. 参考链接

- [Moving OpenCode Desktop to Electron（官方说明）](https://dev.to/brendonovich/moving-opencode-desktop-to-electron-4hip)
- [DeepWiki: OpenCode Desktop Applications](https://deepwiki.com/anomalyco/opencode/3.3-desktop-applications)
- [OpenDeep: Desktop app and embedded sidecar](https://opendeep.wiki/sst/opencode/product-surfaces.desktop-app-and-embedded-sidecar)
- [opencode-beta 仓库](https://github.com/anomalyco/opencode-beta)
