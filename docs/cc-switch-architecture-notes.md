# cc-switch 架构调研与本项目对照

> 调研时间：2026-09-28
> 动机：继续找同类开源项目对标。cc-switch 与 OpenCode Desktop 是**两种相反的标本**——
> OpenCode 从 Tauri 迁去 Electron，而 cc-switch 是纯 Tauri 2 且做得很成熟。
> 更关键的是：cc-switch 的**核心功能就是「统一管理多个 AI CLI 的 MCP 配置」**，
> 这跟本工程的 `core/src/mcp_targets.py` + `python-sidecar/mcp_clients.py` 是同一件事。

---

## 0. 信息来源与可信度说明

本篇**没有直接读 cc-switch 源码**，依据是两份第三方分析：

- [《cc-switch 源码深度解析》](https://book.cuiliang.ai/cc-switch-deep-dive/)（作者 Liang Cui，
  基于 **v3.13.0** 源码，30 章，每章附源码锚点）
- [《CC Switch 核心架构与设计原理深度解析》](https://xuqi2024.github.io/2026/07/23/2026-07-23-cc-switch-tauri-provider-management-multi-coding-agent-architecture-deep-dive/)
  （基于 **2026-07-22 的 main 分支**）

两份文档在代码行数等口径上略有出入（一份说 217 个 Rust 文件、仓库 64.4 MB；
另一份说约 34,000 行 Rust、200+ IPC 命令），下面凡是引用具体数值的地方都标注来源，
**未标注的属于两份文档一致的结论**。上游仓库：[farion1231/cc-switch](https://github.com/farion1231/cc-switch)（MIT）。

---

## 1. 它是什么

一个**跨平台桌面应用**（Tauri 2），用来统一管理 8 款 AI 编码 CLI 的配置：

| CLI | 配置文件 | 格式 |
| --- | --- | --- |
| Claude Code | `~/.claude/settings.json`、`~/.claude.json` | JSON |
| Claude Desktop | 3P provider 配置 | JSON |
| Codex | `~/.codex/config.toml` + `auth.json` | TOML |
| Gemini CLI | `~/.gemini/.env` + `~/.gemini/settings.json` | ENV / JSON |
| Grok Build | `~/.grok/config.json` | JSON |
| OpenCode | `~/.opencode/config.toml` | TOML |
| OpenClaw | 独立 schema | — |
| Hermes Agent | 独立 schema | — |

管的东西：**供应商（Provider）切换、MCP 服务器、Skills、Prompts、会话、用量统计**。
还带一个本地 HTTP 代理，做请求路由 / 故障转移 / 熔断。

它的自我定位是「**零侵入**」：即使卸载 cc-switch，各 CLI 仍能正常工作——
因为 live 配置文件是独立可读写的，不依赖 cc-switch 的数据库。

---

## 2. 技术栈

| 层 | 选型 | 版本 |
| --- | --- | --- |
| 桌面框架 | **Tauri 2** | 2.8.2 |
| 后端 | Rust（tokio / axum / hyper / rusqlite / serde / toml_edit / tempfile） | Rust 1.85+ |
| 前端 | React 18 + TypeScript | — |
| 存储 | SQLite（`rusqlite` bundled），单一事实源 | `SCHEMA_VERSION = 16` |
| 代理 | Axum + **手写 hyper accept loop**，监听 `127.0.0.1:15721` | — |

前端依赖值得一提：`@tanstack/react-query@5`（服务端状态缓存）、Radix UI（shadcn/ui）、
Tailwind 3、i18next、react-hook-form + zod、dnd-kit、CodeMirror 6、cmdk、recharts。

Tauri 插件：`log`、`opener`、`process`、`updater`、`dialog`、`store`、`deep-link`、
`single-instance`。

两处「不寻常」的选型，都很务实：

1. **代理层手写 hyper 而不是全用 Axum** —— 需要 `preserve_header_case(true)`。
   某些中转 API 对 HTTP header 大小写敏感（`anthropic-version` 被规范成
   `Anthropic-Version` 会直接 401），Axum 默认会规范化，只能下沉到 hyper。
2. **内嵌 `rquickjs`（JS 引擎）** —— 让用户用 JS 脚本写「余额查询」，因为每个
   供应商的余额 API 格式都不一样。

---

## 3. 六层架构

```
UI 层            React 18 + TS，跑在 WebView
Tauri Command 层 IPC 命令入口（约 30 个子模块 / 200+ 命令）
Service 层       事务性保护、切换原语
Domain 层        Provider / McpServer 值对象
Adapter 层       8 款 CLI 各自的 schema 适配
Storage 层       SQLite + live 配置文件
```

目录组织上，**前端按功能域、后端按层次**：

```
src/components/          # 前端按域，每个域自带 components/hooks/utils
├── providers/ mcp/ skills/ prompts/ proxy/ sessions/
├── settings/ usage/ workspace/ universal/ agents/ env/ deeplink/ ui/

src-tauri/src/           # 后端按层 + 独立子系统
├── commands/            # L1 IPC 边界（30 个子模块）
├── services/            # L2 业务服务
├── database/            # L3 持久化（SQLite DAO）
├── proxy/               # 独立子系统（15 文件 / ~7K 行）
├── session_manager/     # 独立子系统
├── mcp/ deeplink/       # 独立子系统
├── provider.rs          # 领域模型
└── codex_config.rs / gemini_config.rs / ...  # 单文件配置适配器
```

**循环依赖防火墙**（值得学）：
- `services/` 不依赖 `commands/`
- `database/dao` 不依赖 `services/`
- `proxy/` 只依赖 `database/` 和公共工具

效果是每一层都能单独做单元测试。

**三种并发模型并存**：Tauri async command、代理自己的 Tokio runtime、
以及文件 IO / rusqlite 这类同步操作通过 `tokio::task::spawn_blocking` 桥接。

---

## 4. ⭐ 原子写入与配置安全（最值得抄的一章）

### 4.1 问题

```rust
// ❌ 反模式：非原子
let mut file = File::create(path)?;   // 立即截断原文件
file.write_all(new_content)?;         // 崩溃 / 断电 → 原文件已截断，新内容没写完
```

后果：用户的 `~/.claude.json` 变成空文件或半截文件，CLI 启动时解析失败。

### 4.2 cc-switch 的做法（`src-tauri/src/config.rs`）

```rust
pub fn atomic_write(path: &Path, content: &str) -> Result<(), AppError> {
    // 1. 自动创建父目录
    if let Some(parent) = path.parent() { fs::create_dir_all(parent)?; }

    // 2. 备份旧文件
    if path.exists() {
        fs::copy(path, &path.with_extension("json.bak"))?;
    }

    // 3. 同目录临时文件 + 写 + fsync + 原子 rename
    let tmp = tempfile::NamedTempFile::new_in(
        path.parent().unwrap_or_else(|| Path::new("."))
    )?;
    tmp.as_file().write_all(content.as_bytes())?;
    tmp.as_file().sync_all()?;          // 强制落盘，别留在 page cache
    tmp.persist(path)?;                 // rename 是原子的
    Ok(())
}
```

四个要点，缺一不可：
- **临时文件必须同目录** —— 跨卷 rename 会退化成 copy，就不再原子
- **写完要 `sync_all()`** —— 否则 rename 之后内容可能还在 page cache
- **`persist()`** —— 把 rename 包成「成功或保持原样」
- **先备份** —— 万一文件系统本身出问题，用户还有退路

### 4.3 JSON 双重保护

```rust
pub fn write_json_file<T: Serialize>(path: &Path, value: &T) -> Result<(), AppError> {
    let content = serde_json::to_string_pretty(value)?;
    let _: Value = serde_json::from_str(&content)?;   // 自我校验：写什么就能读回什么
    atomic_write(path, &content)
}
```

### 4.4 TOML 用 `toml_edit` 保留式编辑

```rust
let mut doc: DocumentMut = existing_content.parse()?;
doc["profile"]["default"]["model"] = toml_edit::value("gpt-4");
atomic_write(path, &doc.to_string())?;   // 注释与原始格式都还在
```

如果改用 `toml` crate 做全量序列化，用户的注释和排版会全部丢失。

### 4.5 启动时配置损坏的兜底

```rust
match load_multi_app_config() {
    Ok(cfg) => cfg,
    Err(e) => {
        init_status::set_error(&e, &path);
        app.emit("configLoadError", ...)?;   // 不 panic，交给前端
    }
}
```

前端收到事件 → 弹窗提示「可从 `.bak` 恢复」→ 退出。

---

## 5. MCP 统一管理与双向同步（跟本工程同一件事）

### 5.1 SSOT 数据模型

```rust
pub struct McpServer {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub enabled: bool,
    pub apps: McpApps,        // 这个 server 要出现在哪些 CLI 里
    pub notes: Option<String>,
}

pub struct McpApps {
    pub claude: bool, pub codex: bool, pub gemini: bool,
    pub grokbuild: bool, pub opencode: bool, pub hermes: bool,
}
```

**只存一份**，`apps` 标志矩阵记录它「应该」出现在哪些 CLI 的 live 配置里。
切换 `apps.claude = true/false` 就触发注入 / 移除。

### 5.2 同步与反向导入

```rust
sync_enabled_to_claude / sync_enabled_to_codex / sync_enabled_to_gemini ...
sync_single_server_to_claude / ...
import_from_claude / import_from_codex / import_from_gemini ...
```

**为什么是 8 套 sync 函数而不是循环**：即便抽象出 `McpApps` 标志矩阵，
最终写入仍是 8 条不同代码路径——Claude 在 `~/.claude.json` 顶层 `mcpServers`，
Codex 在 `config.toml` 的 `[mcp_servers]`，Gemini 在 `settings.json`……

反向导入的 UI 流程：扫描各 CLI 的 MCP 配置 → 按 name 合并去重 →
用户勾选 → 写入 SSOT 并设置 `apps` 标志。

### 5.3 它明确的权衡：「写前不读」

> 如果用户手动改了 live 文件，cc-switch 不知道。下次同步时会覆盖用户的更改。
> cc-switch 的策略是**写前不读**，切换或 enable 触发完整覆写。

这是 SSOT 架构的本质代价——换来的是「一次编辑，多处同步」。

### 5.4 所有权 sentinel（避免误接管）

```rust
pub const CC_SWITCH_CODEX_OFFICIAL_PROXY_PROVIDER_ID: &str = "cc-switch-official";
```

用**专属字符串 ID** 而不是通用的 `localhost:15721` 作为「这是我写的」标记，
这样用户自己配置的、恰好也指向 localhost 的 Provider 不会被误认成接管对象。

---

## 6. 本地代理 / 熔断（本工程不需要，但值得知道设计）

- 代理监听 `127.0.0.1:15721`，**默认不启动**，只在用户开启「代理接管」时启动
- 熔断器三态机：`failure_threshold = 4`、`success_threshold = 2`、
  `timeout_seconds = 60`、`error_rate_threshold = 0.6`、`min_requests = 10`
- **熔断器 key 是 `app_type:provider_id`** —— 避免 Claude Code 熔断连带影响 Codex
- Failover 按队列顺序 P1 → P2 → P3，**按入库顺序而非 star 评分**，
  避免每次调用顺序变化导致行为不可预测
- 切换去重用 `pending_switches: HashSet` + **写锁占位**（而非读锁重试），
  避免并发请求拿到同一个失败任务
- 切换成功后发 Tauri 事件 `provider-switched`，前端监听并更新托盘菜单与激活态

---

## 7. 托盘 / 打包 / 自动更新

**托盘**（`src-tauri/src/tray.rs`，481 行）：
- 右键出菜单：各 App 的 Provider 子菜单（当前项带 ●）、代理 / 故障转移开关、
  显示主窗口 / 设置 / 退出
- 菜单项 ID 约定 `"{action}:{arg}:{arg}"`，例如 `switch:claude:uuid-xyz`
- **状态变化就整棵重建菜单**（`tray.set_menu(Some(menu))`），不做增量更新
- 左键单击显示主窗口
- 代理运行时切换托盘图标（绿点 / 空闲两套图标）
- macOS 暗色模式用白色图标、亮色用黑色；Windows / Linux 用彩色

**打包**（`tauri.conf.json`）：
```json
"targets": ["dmg", "app", "nsis", "msi", "deb", "appimage", "rpm"],
"identifier": "ai.cc-switch.app",
"resources": ["resources/**/*"]
```

**体积优化**（`Cargo.toml` 的 `[profile.release]`）：
```toml
codegen-units = 1
lto = "thin"
opt-level = "s"       # 优先体积
panic = "unwind"      # 保留 backtrace，崩溃报告要用
strip = "symbols"
```

**自动更新**：`tauri-plugin-updater` + **签名的清单文件**。
`tauri signer generate` 生成密钥对，私钥签构建产物，公钥嵌进 app；
更新时验证签名。前端 `UpdateContext.tsx` + `UpdateBadge.tsx`，
`check()` → 有更新 → `downloadAndInstall()` → `relaunch()`。

**单实例 + Deep Link**：`tauri-plugin-single-instance` 保证第二次启动的参数
转发给第一个实例——这对 `ccswitch://` 协议是必需的。

**开机自启**：`auto-launch` crate，macOS 用 LaunchAgent plist、
Windows 用注册表、Linux 用 `autostart/` 下的 `.desktop`。

---

## 8. 它自己承认的复杂度代价

摘自其分析文档的「挑战」部分，值得作为我们的预警：

- 二进制体积约 **30-50 MB**（含 WebView runtime）
- 启动到托盘可见需 **0.8-1.5 秒**
- **217 个 Rust 文件** + 大量 Adapter，新贡献者要先理解六层架构
- **每个上游 CLI 升级都要在 Adapter 层打补丁** —— 这是长期维护税
- 故障转移「可见性」不足：UI 只显示「已切换」，不显示「为什么切」
- Skills 的 symlink 同步依赖 `SeCreateSymbolicLinkPrivilege`，
  Windows 旧版会失败并回退 copy，磁盘占用翻倍
- Schema 迁移摩擦：`SCHEMA_VERSION = 16`，老用户首次启动要跑 16 次 migration

---

## 9. 逐项对照本工程

| 关注点 | cc-switch | 本工程 | |
| --- | --- | --- | --- |
| 桌面框架 | Tauri 2 | Tauri 2 + Electron 双外壳 | ✅ 栈相同 |
| 管理多个 CLI 的 MCP 配置 | ✅ 8 款，SSOT + 标志矩阵 | ✅ 9 款（`mcp_targets.py`） | ✅ 同类功能 |
| 只动自己那一个条目、保留其他键 | ✅ | ✅（`_is_comsol_entry()` 识别） | ✅ |
| 写入前备份 | ✅ 且多份轮转 | ✅ `shutil.copy2` → `.bak`（**只留一份**） | ⚠️ |
| **原子写入** | ✅ temp + fsync + rename | ❌ `path.write_text()` 直接覆写 | ❌ |
| **写前自校验** | ✅ 序列化后 parse 回来验一遍 | ❌ | ❌ |
| **TOML 保留式编辑** | ✅ `toml_edit` | ⚠️ 正则切段落替换，非解析器 | ⚠️ |
| 反向导入（把已有 live 配置收进 SSOT） | ✅ `import_from_*` | ❌ 只判断「注册没注册」 | ❌ |
| 所有权 sentinel | ✅ 专属 ID | ✅ 专属条目名 `comsolpilot` | ✅ |
| 单实例 | ✅ 插件 | Electron ✅ / **Tauri ❌** | ⚠️ 对等性缺口 |
| 托盘 | ✅ 动态菜单 + 状态图标 | ❌ | ❌ |
| 自动更新 | ✅ 签名清单 | ❌ | ❌ |
| 开机自启 | ✅ | ❌ | 不需要 |
| release 体积优化 profile | ✅ lto/opt-level/strip | ❌ 无 `[profile.release]` | ❌ |
| 打包 target | nsis + msi + dmg + deb + appimage + rpm | 只有 `nsis` | ⚠️ 够用 |
| 前端状态管理 | TanStack Query（缓存 + 失效） | 自研 `lib/appState.ts` 轮询 | ⚠️ |
| 多语言 | i18next（中/英/日） | 中文硬编码 | 暂不需要 |
| Deep Link | `ccswitch://` 一键导入 | ❌ | 不需要 |

**我们在两处比它更稳**：
1. 它是「写前不读」的 SSOT 覆写，用户手改 live 文件会被覆盖；
   我们是外科手术式只改自己那一条，对用户更友好。
2. 它要维护 8 套 Adapter，每个上游 CLI 升级都要打补丁；
   我们的目标客户端虽多，但写入口径统一，没有这个长期税。

---

## 10. 建议（按性价比排序）

### P0 —— 真会损坏用户数据

**10.1 给 MCP 客户端配置写入加原子性**

现状（`core/src/mcp_targets.py`）：

```python
def _write_json(path: Path, config: dict) -> dict[str, Any]:
    if path.is_file():
        shutil.copy2(path, path.with_suffix(path.suffix + ".bak"))   # 有备份
    path.write_text(json.dumps(config, ...), encoding="utf-8")       # ← 非原子
```

`_sync_codex()` 同样在第 380 行 `path.write_text(new_text, ...)`。

我们写的是用户的 `~/.claude.json`、`~/.codex/config.toml`、Cursor / Windsurf 的
MCP 配置。**一旦在写入过程中崩溃或断电，用户整个 MCP 配置就废了**——
而这不是「我们自己的数据」，是用户别的工具在用的配置。

改法（Python 版，等价于 cc-switch 的 `atomic_write`）：

```python
import os, tempfile

def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())      # 关键：落盘
        os.replace(tmp, path)              # 关键：同目录 rename 才是原子的
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
```

要点与 cc-switch 一致：**临时文件必须同目录**、**必须 `fsync`**、**用 `os.replace`**。

**10.2 写前自校验**

`_write_json` 现在直接 `json.dumps` 就写。应先 `json.loads()` 验一遍——
写什么就要能读回什么。TOML 那边是手写字符串拼装（`_codex_block` / `_toml_literal`），
更应该写完后用 `tomllib` 解析验证（Python 3.11+ 自带），
拼错了要在**写盘之前**发现。

**10.3 补上 Tauri 侧的单实例锁**

`src-tauri/Cargo.toml` 的依赖里**没有 `tauri-plugin-single-instance`**，
`src-tauri/src/*.rs` 里也 grep 不到任何单实例逻辑。而 Electron 侧有
`app.requestSingleInstanceLock()`。

这违反本工程自己的「两套外壳能力对等」约定，后果很具体：
**用户双击两次图标 → 两个 Tauri 实例 → 两个 sidecar → 抢同一个 COMSOL 端口。**

### P1 —— 结构性改进

**10.4 备份轮转**：现在 `.bak` 每次被覆盖，只保留一代。
建议按时间戳保留 5-10 份，或至少加个 `.bak.1`。

**10.5 Codex TOML 的段落替换有边界问题**

```python
_SECTION_HEADER = re.compile(r"^\[mcp_servers\.comsolpilot\]\s*$", re.MULTILINE)
_NEXT_HEADER = re.compile(r"^\[", re.MULTILINE)
```

`_NEXT_HEADER` 找的是**下一个 `[`**，所以夹在我们这一节和下一节之间的
**注释行会被算进被替换的范围里，一起丢掉**。用 `tomllib` 解析定位（或至少
把注释行排除出替换区间）更稳。这一条跟 10.2 的自校验是一起解决的。

**10.6 release 体积优化**：给 `src-tauri/Cargo.toml` 加

```toml
[profile.release]
codegen-units = 1
lto = "thin"
opt-level = "s"
panic = "unwind"
strip = "symbols"
```

**10.7 系统托盘** —— 这一条对我们比对 cc-switch 更有价值：
我们管着一个**长驻的 COMSOL 服务端**（headless 模式），
用户最小化窗口后应该还能看到「服务端在跑 / 停了」，并能一键启停。
现在完全没有托盘，关掉窗口就等于丢掉控制台。

### P2 —— 打包阶段

**10.8 `tauri-plugin-updater`**（签名清单 + 公钥），装前先停 sidecar。
**10.9 打包 target 加 `msi`**（现在只有 `nsis`），企业环境有时要求 MSI。
**10.10 考虑引入 TanStack Query** 替换自研轮询——它自带缓存、失效、乐观更新，
cc-switch 用得很成功；我们现在多处各自轮询 `/api/state`。

---

## 11. 参考链接

- 上游仓库：[github.com/farion1231/cc-switch](https://github.com/farion1231/cc-switch)（MIT，作者 Jason Young）
- [《cc-switch 源码深度解析》](https://book.cuiliang.ai/cc-switch-deep-dive/)（第三方，基于 v3.13.0）
- [《CC Switch 核心架构与设计原理深度解析》](https://xuqi2024.github.io/2026/07/23/2026-07-23-cc-switch-tauri-provider-management-multi-coding-agent-architecture-deep-dive/)
- [CC Switch 官网](https://ccswitch.ai/zh/)
