# COMSOLPilot Desktop

用 AI 直接驱动 COMSOL Multiphysics 的桌面应用。

核心 COMSOL 自动化逻辑（MCP 服务端、几何/物理/网格/求解/结果等工具）沿用
原 `COMSOLPilot` 项目，外面包一层原生桌面壳，把原本要敲命令行的操作
——「检测 COMSOL / 装依赖 / 接入 AI 客户端 / 启停服务端」——变成点几下就能完成。

---

## 架构

```
┌──────────────────────────────────────────────┐
│  React 前端              src/                 │  引导向导、概览、客户端、设置、日志
└──────────────────┬───────────────────────────┘
                   │  fetch → 127.0.0.1:<随机端口>
                   │  带 X-COMSOLPILOT-TOKEN
┌──────────────────▼───────────────────────────┐
│  Rust 外壳               src-tauri/           │  窗口、原生文件夹选择器、
│                                               │  挑选端口与令牌、拉起/回收 sidecar
└──────────────────┬───────────────────────────┘
                   │  子进程（开发态直接跑 Python，打包态跑 bundled exe）
┌──────────────────▼───────────────────────────┐
│  Python sidecar          python-sidecar/      │  REST 接口层，只做「系统能力 + 编排」
│  FastAPI                                      │  不重新实现任何 COMSOL 逻辑
└──────────────────┬───────────────────────────┘
                   │  import / 子进程
┌──────────────────▼───────────────────────────┐
│  COMSOLPilot 核心        core/                │  MCP 服务端 + 全部工具 + 启动脚本
│  src/ scripts/ workspace/                     │  由 AI 客户端进程加载并连接 COMSOL
└──────────────────────────────────────────────┘
```

**分层的意义**：前端和外壳只碰「界面」和「原生能力」，业务逻辑全在 Python。
以后改 COMSOL 相关的行为，只动 `core/` 或 `python-sidecar/`，前端基本不用改。

---

## 双外壳：Tauri 还是 Electron

最上面那层**外壳**有两套实现，共用同一份 React 界面和同一个 Python 后端，
可以按需二选一发布：

| | Tauri（`src-tauri/`，Rust） | Electron（`electron/`，Node） |
| --- | --- | --- |
| 安装包体积 | ~10 MB | ~180 MB（自带 Chromium + Node） |
| 运行内存 | 低 | 较高 |
| 编译前提 | Rust + MSVC 工具链 | 只需 Node.js |
| 调试 | 改 Rust 要重新编译 | Chrome DevTools 直接调 |
| 生态 | 较新，插件少 | 成熟，商用桌面软件主流选择 |

**怎么选**：机器上没装 Rust、想立刻出安装包、或需要成熟生态（托盘、自动更新、
崩溃上报），选 **Electron**；在意体积与内存、且愿意维护 Rust 工具链，选 **Tauri**。

两者职责边界完全一致，能力一一对应：

| 能力 | Tauri (Rust) | Electron (Node) |
| --- | --- | --- |
| 挑空闲端口 | `portpicker::pick_unused_port` | `net.createServer` 监听 0 端口 |
| 生成令牌 | `RandomState` 取 128 位 | `crypto.randomBytes(16)` |
| 拉起 sidecar | `Command::new(python)` / `externalBin` | `spawn(...)` |
| 转发日志 | `emit("sidecar-log")` | `webContents.send(...)` |
| 原生选目录 | `tauri_plugin_dialog` | `dialog.showOpenDialog` |
| 打开目录 | `explorer` / `open` / `xdg-open` | `shell.openPath` |

**前端怎么做到两边通用**：外壳差异全部收在 `src/lib/shell.ts` 一个文件里。
它按 `__TAURI_INTERNALS__` / `window.comsolpilot` 判断当前跑在哪个外壳里，
对上暴露同一组语义（拿端口、拿令牌、选目录、打开目录、订阅日志）。
业务组件只认 `shell.ts`，不直接 import 任何一个外壳的 API——所以加第三种外壳
也只需要再写一份这个文件。

> **Electron 打包态为什么不走 `file://`**：`file://` 页面里
> `<script type="module">` 会被 Chromium 的 CORS 拦掉（vite 的入口恰好就是 module
> script），而且 `file://` 的 Origin 是 `null`，会被 sidecar 的 CORS 白名单拒绝。
> 所以主进程注册了 `app://localhost` 自定义协议来挂前端，白名单里对应放行这一条。

---

## 界面

视觉与布局对齐 **COMSOL Multiphysics** 的桌面端：方角、灰底、小字号、密集排布，
而不是常见的圆角卡片式网页风格。

```
┌──────────────────────────────────────────────────────────────┐
│ COMSOLPilot — AI 驱动的 COMSOL 控制台                          │  标题栏
├──────────────────────────────────────────────────────────────┤
│ 文件   视图   工具   帮助                                      │  菜单栏
├──────────────────────────────────────────────────────────────┤
│ [主页]  模型   运行   视图                                     │  功能区选项卡
│  ▶启动 ■停止 ↻重启 │ ↻刷新 ～检测 │ ✨向导                      │  功能区按钮组
├────────────────┬─────────────────────────────────────────────┤
│ 模型开发器      │                                             │
│  ▾ 全局定义     │                                             │
│     基本设置    │              内容区                          │
│  ▾ COMSOL 安装  │     （概览 / AI 客户端 / 设置 / 消息与日志）   │
│    运行环境     │                                             │
│    服务端       │                                             │
├────────────────┴─────────────────────────────────────────────┤
│ 消息 | COMSOL 日志                          完整日志   收起    │  消息栏
├──────────────────────────────────────────────────────────────┤
│ ● 就绪 │ 运行中 :2036 │ COMSOL 6.0 │ Python 3.12.14          │  状态栏
└──────────────────────────────────────────────────────────────┘
```

三条导航入口——**菜单栏、功能区、模型开发器**——通向同一批页面，
同一个动作在哪触发行为都一致：全部收敛在 `App.tsx` 的 `ChromeActions` 里实现。

数据上，外壳（状态栏、功能区）和页面共用 `lib/appState.ts` 里那一份 `/api/state`：
只有一个地方在轮询，避免两边各拉一遍、还可能不同步。

配色与尺寸令牌集中在 `index.css` 顶部的 `:root`（表面 / 边框 / 文字 / 主色四组），
换配色只动那里。字体用系统字体（Segoe UI / 微软雅黑），不引外部字体——
桌面应用离线也要能正常显示。

---

## 目录结构

```
comsolpilot-desktop/
├── core/                       COMSOLPilot 核心（原 COMSOLPilot-main 的全部内容）
│   ├── src/                    MCP 服务端与全部工具
│   ├── scripts/                启动 / 停止 / 端口同步 / 版本枚举等脚本
│   ├── workspace/              运行期状态：settings.json、runtime.json、logs、models
│   ├── requirements-windows.txt
│   └── start_comsol_server.bat
│
├── python-sidecar/             桌面壳后端（FastAPI）
│   ├── sidecar_server.py       REST 接口
│   ├── paths.py                路径解析（开发态 / 打包态两套布局）
│   ├── core_bridge.py          把 core 接入 sidecar 进程（sys.path + Windows 环境变量）
│   ├── comsol_locator.py       COMSOL 探测与版本切换
│   ├── deps_installer.py       发现并复用已有 Python 环境（找不到才建 venv）
│   ├── mcp_clients.py          MCP 客户端注册（转调 core/src/mcp_targets.py）
│   ├── server_manager.py       COMSOL 服务端生命周期（转调 core/scripts/*.ps1）
│   └── build_sidecar.py        用 PyInstaller 打包成单文件 exe
│
├── src/                        React 前端（两种外壳共用）
│   ├── components/             外壳：菜单栏 / 功能区 / 模型树 / 消息栏 / 状态栏
│   ├── components/onboarding/  五步引导向导
│   ├── pages/                  概览 / AI 客户端 / 设置 / 日志
│   ├── lib/shell.ts            运行时外壳抽象（Tauri / Electron / 浏览器）
│   ├── lib/appState.ts         全局状态：外壳与页面共用的 /api/state
│   └── lib/api.ts              sidecar 客户端封装
│
├── src-tauri/                  Rust 外壳（Tauri）
│   ├── src/main.rs             入口：端口、令牌、原生命令
│   ├── src/sidecar.rs          sidecar 生命周期 + 日志转发
│   ├── icons/                  应用图标
│   └── tauri.conf.json
│
├── electron/                   Node 外壳（Electron）
│   ├── main.ts                 入口：窗口、端口、令牌、拉起后端、IPC
│   ├── preload.ts              把原生能力挂到 window.comsolpilot
│   └── tsconfig.json           主进程单独编译成 CJS
│
├── electron-builder.yml        Electron 打包配置（与 tauri.conf.json 对等）
├── resources/sidecar/          Electron 用的后端 exe（由 sidecar:build 生成）
│
└── scripts/
    ├── generate_icons.py       生成 src-tauri/icons 下的图标
    └── compile-electron.mjs    编译 electron/*.ts 到 dist-electron/
```

---

## 环境要求

| 组件 | 版本 | 用途 |
| --- | --- | --- |
| Node.js | ≥ 18 | 前端构建 |
| Rust | stable（含 MSVC 工具链） | Tauri 外壳编译 |
| Python | 3.10 – 3.13 | 核心运行环境（优先复用你机器上已有的，找不到才新建） |
| COMSOL | 任意已安装版本 | 被驱动的目标 |

Rust 环境的安装见 <https://v2.tauri.app/start/prerequisites/>。

---

## 环境复用优先（新用户友好）

**不需要先准备一个干净的 Python 环境。** 应用在装依赖前会先「摸底」，
按下面的顺序把机器上已经能用的环境找出来：

1. 上次用过的解释器（`core/workspace/settings.json` 里的 `python_exe`）
2. 环境变量 `COMSOLPILOT_PYTHON`
3. 本工程自带的 `core/.venv`
4. **你正在用的 MCP 客户端配置**里 `comsolpilot` 那条 `command` 指向的解释器
   （读 `mcpServers` / `[mcp_servers.comsolpilot]`）
5. 其它位置已存在的 COMSOLPilot 安装
6. Conda 环境、PATH 里的 `python`

对每个候选都用 `importlib.util.find_spec` 探一遍
`mcp` / `mph` / `jpype` / `pydantic` 是否齐全（只探测、不 import，避免拉起 JVM）。

- **找到能用的** → 直接复用，**不下载、不建 venv**，界面会列出候选让你确认，
  也可一键切到某个环境；
- **一个能用的都没有** → 才在本工程 `core/` 下建 venv 并安装
  `requirements-windows.txt`。

复用到的解释器会被写回 `settings.json`，并一路贯穿到 COMSOL 探测、服务端启动、
以及写进 MCP 客户端的 `command`，保证全程用的是同一个环境。

> 界面路径：引导向导「依赖」一步会进入**选择环境**页面（`DependencyStep`），
> 概览页的「Python 环境」卡片会显示当前解释器、来源与是否可复用。

---

## 本地开发

```bash
# 1. 前端依赖
npm install

# 2. 起开发模式，二选一
npm run tauri:dev      # Tauri：同时拉起 vite 和 Rust（需要装 Rust）
npm run electron:dev   # Electron：同时拉起 vite 和 Electron（只需要 Node）
```

两种外壳的开发态都会**自动用 `python` 直接跑 `python-sidecar/sidecar_server.py`**，
不需要先打包 sidecar。想指定解释器就设环境变量 `COMSOLPILOT_PYTHON`。

> Electron 首次 `npm install` 要从网上拉约 100 MB 的运行时。国内网络建议先设镜像：
>
> ```bash
> export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
> export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
> ```

只调后端（不开窗口）时：

```bash
pip install -r python-sidecar/requirements.txt
python python-sidecar/sidecar_server.py --port 8765
# 不带 --token 时自动关闭令牌校验，方便用 curl 直接打
```

只调前端界面（用浏览器开，接口仍指向本机 sidecar）：

```bash
npm run dev        # http://localhost:5173
```

---

## 打包

两种外壳的前两步一样，第三步二选一：

```bash
# 1. 生成图标（仓库里已带一份，换 logo 时才需要）
npm run icons

# 2. 把 Python 后端打成单文件 exe
#    同时产出两份：src-tauri/binaries/（给 Tauri）、resources/sidecar/（给 Electron）
npm run sidecar:build

# 3. 打包安装程序，二选一
npm run tauri:build      # 产物：src-tauri/target/release/bundle/nsis/COMSOLPilot_0.2.0_x64-setup.exe
npm run electron:build   # 产物：release/COMSOLPilot_0.2.0_x64-setup.exe
```

双击安装后会自动创建开始菜单快捷方式与卸载程序。

> **打包态的核心目录**：sidecar 首次安装依赖时，会把随包的核心复制到
> `%LOCALAPPDATA%\COMSOLPilot\core`。这是必须的——MCP 客户端要自己执行
> `python -m src.server`，需要一个真实存在、可写的目录，PyInstaller 的临时解包
> 目录做不到这点。

---

## 安全模型

本地服务虽然只绑 `127.0.0.1`，但浏览器里任意网页都能向本机端口发请求，所以：

- **只绑回环地址**，不对外网暴露；
- **CORS 白名单**：只放行 `tauri://localhost`、`http(s)://tauri.localhost`、
  Electron 的 `app://localhost`，以及 `localhost` / `127.0.0.1` 的任意端口
  （覆盖 vite 开发态）；
- **启动令牌**：Rust 每次启动生成随机 token 传给 sidecar，所有 `/api/*` 请求都要
  带 `X-COMSOLPILOT-TOKEN`。手动运行时不传 `--token` 即自动关闭校验。

---

## 配置项

保存在 `core/workspace/settings.json`，界面「设置」页可改：

| 键 | 说明 |
| --- | --- |
| `port` | COMSOL 服务端端口，默认 2036 |
| `login_mode` | `auto` / `never` / `info` / `force`，COMSOL 服务端登录模式 |
| `comsol_version` | 固定的 COMSOL 版本；留空为「最新安装」 |
| `comsol_server_exe` | 手动指定的 `comsolmphserver.exe` |
| `comsol_desktop_exe` | 手动指定的 `comsol.exe` |
| `cores` | 计算核数，0 表示交给 COMSOL 决定 |
| `table_label` | AI 建表时的标签前缀，留空表示不重命名 |

运行期状态（不要手改）：

- `core/workspace/runtime.json` — 当前服务端的端口、PID、启动时间；
- `core/workspace/logs/` — COMSOL 服务端的启动日志。

---

## 接口一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 存活与核心目录 |
| GET | `/api/state` | 概览页聚合状态（廉价，可轮询） |
| GET | `/api/comsol/detect` | 完整探测 COMSOL（较慢） |
| POST | `/api/comsol/path` | 手动指定安装目录 |
| GET | `/api/comsol/versions` | 枚举已安装版本 |
| POST | `/api/comsol/version` | 切换固定版本 |
| GET | `/api/deps/status` | 依赖状态（含当前解释器与来源） |
| GET | `/api/deps/environments` | 枚举候选环境并标注是否可复用 |
| POST | `/api/deps/use` | 切换到指定解释器 |
| POST | `/api/deps/install` | 装依赖（默认复用优先；`force=true` 才新建） |
| GET | `/api/clients` | 客户端列表与状态 |
| POST | `/api/clients/register` | 注册选中的客户端 |
| POST | `/api/clients/sync` | 同步已注册客户端的端口 |
| GET | `/api/server/status` | 服务端状态 |
| POST | `/api/server/start` | 启动（异步，立刻返回） |
| POST | `/api/server/stop` | 停止 |
| POST | `/api/server/restart` | 重启 |
| GET | `/api/logs/tail` | 读取最新 COMSOL 日志尾部 |
| GET/POST | `/api/settings` | 读写设置 |
| POST | `/api/shutdown` | 优雅退出 |

---

## 相比原始脚手架补齐了什么

原始桌面脚手架只有架构骨架，以下位置都留了 `TODO` 或直接是占位实现：

| 位置 | 原状态 | 现在 |
| --- | --- | --- |
| 核心逻辑 | 躺在另一个项目里，桌面工程跑不起来 | 并入 `core/`，工程自包含 |
| `mcp_clients.py` | 返回假数据 | 转调 `src/mcp_targets.py`：真实探测 + 备份写入 |
| 服务端启停 | 占位命令 `uv run python -m src.server` | 转调 `scripts/start_comsol_server.ps1`，含端口顺延、日志端口回读、异步状态机 |
| 依赖安装 | `uv sync` | **发现并复用已有环境**，找不到才建 venv + `requirements-windows.txt` |
| COMSOL 探测 | 只在 sidecar 进程里 import mph | 走核心脚本子进程，sidecar 不必打包 jpype |
| 开发联调 | 需要手工改 Rust 代码才能跑 | 开发态自动回退到直接跑 Python |
| 跨域 | 没配 CORS，前端请求必被浏览器拦 | CORS 白名单 + 启动令牌 |
| 图标 | 目录为空，`tauri build` 必失败 | 已生成全套图标，附生成脚本 |
| 界面 | 只有概览和日志两个空壳页 | 概览（COMSOL/环境/服务端/客户端四张卡）、AI 客户端管理、设置、日志 |
| 桌面外壳 | 只有 Tauri（必须装 Rust 才能编译） | 增加 **Electron** 外壳，只需 Node 即可构建；两者差异收敛在 `src/lib/shell.ts` |
| 界面风格 | 暖色衬线 + 圆角卡片（网页语言） | 重做为 COMSOL 的工程软件风格：菜单栏 + 功能区 + 模型开发器 + 消息栏 + 状态栏 |

---

## 常见问题

**启动服务端一直停在「启动中」**
COMSOL 的 JVM 启动通常要 30-60 秒，属正常。到「日志」页看
「COMSOL 服务端日志」，脚本最长等 90 秒。

**提示找不到 `comsolmphserver.exe`**
到「概览 → COMSOL 安装」点「手动选择目录」，选包含 `Multiphysics` 的那一层
（例如 `D:\COMSOL60`）。

**依赖安装失败**
先别急着装——多数情况下你机器上已经有能用的环境。应用会自动发现并复用
（见上文「环境复用优先」）。真要装时，失败多为网络/代理问题：核心用的是 `pip`，
走你本机配置的源；可以先在 `core/` 下手动执行 `python -m venv .venv` 和
`.venv\Scripts\python -m pip install -r requirements-windows.txt` 验证。

**怎么强制用某个 Python？**
「设置」页填 `python_exe`，或在「依赖」一步的候选列表里点「使用这个环境」，
或设环境变量 `COMSOLPILOT_PYTHON`。三者的优先级见上文。

**界面看着不对 / 想改配色**
配色与尺寸都在 `src/index.css` 顶部的 `:root` 里，改那几个变量即可。
改完 `npm run build` 或 `npm run electron:dev` 会热更新。

**AI 客户端里连不上**
客户端加载的是它自己的配置文件，写完配置后需要在该客户端里
**重新信任 / 重启一次连接器**。另外服务端必须先起来。

**改了端口**
「设置」页改完端口后，点「同步已注册客户端」，再重启服务端。

---

## 许可

沿用核心项目的 LICENSE（见 `core/LICENSE`）。
