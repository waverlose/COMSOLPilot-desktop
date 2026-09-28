# 打包与发布

本文只讲 **Tauri 外壳**的打包发布。Electron 外壳见 `electron-builder.yml`，
流程类似但产物路径不同。

---

## 1. 产物是什么

| 目标 | 产物路径 | 用途 |
| --- | --- | --- |
| `nsis` | `src-tauri/target/release/bundle/nsis/COMSOLPilot_<版本>_x64-setup.exe` | 推荐给普通用户。支持自选安装目录、自动建快捷方式、带卸载程序 |
| `msi` | `src-tauri/target/release/bundle/msi/COMSOLPilot_<版本>_x64_en-US.msi` | 企业批量部署 / 组策略分发 |

两者都只装**当前用户**（`installMode: "currentUser"`，注册表写在 `HKCU`），
不需要管理员权限。这一点和 Electron 侧的 `perMachine: false` 是对齐的。

> **MSI 首次构建会联网下载 WiX**（几百 MB，缓存在 `%LOCALAPPDATA%\tauri\`）。
> 如果网络受限导致 MSI 打包失败，用 `npm run tauri:build:nsis` 只出 NSIS 包。

---

## 2. 本地打包

```bash
# 1. 图标（仓库已带一份，只在换 logo 时需要）
npm run icons

# 2. 把 Python 后端打成单文件 exe
#    产出 src-tauri/binaries/comsolpilot-sidecar-x86_64-pc-windows-msvc.exe
#    （同时给 Electron 复制一份到 resources/sidecar/）
npm run sidecar:build

# 3. 出安装包
npm run tauri:build          # nsis + msi
npm run tauri:build:nsis     # 只要 nsis（跳过 WiX 下载）
```

**第 2 步不能跳。** `tauri.conf.json` 里声明了：

```json
"externalBin": ["binaries/comsolpilot-sidecar"]
```

Tauri 打包时要去 `src-tauri/binaries/` 找 `comsolpilot-sidecar-<target-triple>.exe`
（Windows x64 就是 `comsolpilot-sidecar-x86_64-pc-windows-msvc.exe`）。
文件不在，打包直接失败——这个文件名后缀三元组的要求很容易踩，
`python-sidecar/build_sidecar.py` 里的 `target_triple()` 已经处理了。

---

## 3. 版本号：只有一个真源

版本号在四处出现，靠人同步一定会漂：

| 位置 | 作用 |
| --- | --- |
| `package.json` → `version` | **真源** |
| `src-tauri/tauri.conf.json` → `version` | 决定安装包文件名、更新比对基准 |
| `src-tauri/Cargo.toml` → `[package] version` | 决定 exe 的文件属性 |
| `electron-builder.yml` → `${version}` | 直接读 package.json，不需要同步 |

所以改版本号只需要动 `package.json`，然后跑同步脚本：

```bash
npm run version:sync     # 把另外两处对齐到 package.json
npm run version:check    # 只校验；不一致则退出码 1（CI 用这个）
```

`version:sync` 只改 `[package]` 段里的 version，**不会碰 `[dependencies]` 里
每个 crate 的版本号**（Cargo.toml 里两种 `version = "..."` 长得一样，全局正则会一起改掉）。

CI 和发布流水线都会跑 `version:check`，版本分叉会在打包之前就被拦下。

---

## 4. 发布流程

```bash
# 1. 改版本号（package.json 是唯一真源）
npm version patch --no-git-tag-version    # 或手动改

# 2. 同步到 Tauri 的两处清单
npm run version:sync

# 3. 提交并打 tag
git add -A
git commit -m "chore: 发布 0.2.1"
git tag v0.2.1
git push origin main --tags
```

推 tag 会触发 `.github/workflows/release.yml`，它在 `windows-latest` 上：

1. 校验 tag 与 `package.json` 版本一致（不一致直接失败）
2. `version:check` 校验三处清单一致
3. `pip install -r python-sidecar/requirements.txt`（含 PyInstaller）
4. `python python-sidecar/build_sidecar.py` 打 sidecar
5. `tauri-action` 构建 nsis + msi，创建 **草稿态** Release 并上传产物

草稿态是刻意的：先人工确认产物没问题再点发布，比直接发出去再撤回省事。

**CI 每次 push / PR 也会跑** `.github/workflows/ci.yml`：
前端类型检查、前端构建、版本一致性、`tauri.conf.json` 可解析、Python 语法检查，
以及 `cargo check`（本机没装 Rust 工具链，CI 是唯一的编译验证手段）。

> `src-tauri/Cargo.lock` 目前还没入库（这台机器从未编译过）。第一次 CI 跑通后，
> 把它提交进来，然后把 `ci.yml` 里的 `cargo check` 改成 `cargo check --locked`
> 以固定依赖版本。

---

## 5. 体积优化

`src-tauri/Cargo.toml` 里加了 `[profile.release]`：

```toml
[profile.release]
codegen-units = 1     # 默认 16 会切断跨单元内联/死代码消除
lto = "thin"          # 大部分跨 crate 优化收益，编译时间仍可控
opt-level = "s"       # 优先体积；壳里没有热循环
panic = "unwind"      # 不要改 abort：要保留 backtrace 给崩溃报告
strip = "symbols"     # 去掉符号表
```

注意 `panic = "unwind"` 是刻意保留的。改成 `abort` 能再省一点体积，
但会丢掉崩溃时的调用栈——日志里那句「已退出（code=…）」背后的现场就没了。

---

## 6. 启用代码签名（尚未做）

**现状：安装包未签名**，用户首次运行会看到 Windows SmartScreen 的
「Windows 已保护你的电脑」提示，需要点「更多信息 → 仍要运行」。

要做签名，先拿到证书（OV 或 EV 代码签名证书，或改用 Azure Trusted Signing），
然后在 `tauri.conf.json` 的 `bundle.windows` 里二选一：

```json
"windows": {
  "certificateThumbprint": "<证书指纹>",
  "digestAlgorithm": "sha256",
  "timestampUrl": "http://timestamp.digicert.com"
}
```

或者用外部签名命令（支持云签名服务）：

```json
"windows": {
  "signCommand": { "cmd": "path/to/sign-tool", "args": ["%1"] }
}
```

证书指纹在 CI 上不好管理，通常配合 `signCommand` + 云端签名服务使用。

---

## 7. 启用自动更新（尚未做）

Tauri 2 的更新机制是**签名的清单文件**：私钥签构建产物，公钥嵌在应用里，
客户端拿到更新包后验签，验不过就拒绝安装。所以私钥必须妥善保管。

### 7.1 生成密钥对

```bash
npm run signer:generate
# 等价于：tauri signer generate -w .tauri/comsolpilot.key
```

会生成两个文件：

- `.tauri/comsolpilot.key` —— **私钥，绝不入库**（已在 `.gitignore` 里）
- `.tauri/comsolpilot.key.pub` —— 公钥，公开信息，要嵌进应用

> ⚠️ 私钥丢了，已经装出去的版本就**再也收不到更新**，只能让用户手动重装。
> 生成后立刻备份到密码管理器，不要只留在这一台机器上。

### 7.2 装插件

```bash
npm run tauri add updater     # 自动加依赖并注册插件
npm run tauri add process     # 更新完需要重启应用，靠它
```

### 7.3 写配置

在 `src-tauri/tauri.conf.json` 顶层加 `plugins`，并把
`bundle.createUpdaterArtifacts` 打开（不打开就不会生成 `.sig` 和 `latest.json`）：

```json
{
  "plugins": {
    "updater": {
      "endpoints": [
        "https://github.com/<你的账号>/<仓库名>/releases/latest/download/latest.json"
      ],
      "pubkey": "<.tauri/comsolpilot.key.pub 的完整内容>"
    }
  },
  "bundle": {
    "createUpdaterArtifacts": true
  }
}
```

> ⚠️ `createUpdaterArtifacts: true` 之后，**本地不带签名私钥的 `tauri build` 会失败**。
> 本地想跳过签名，把私钥路径给环境变量即可：
> `TAURI_SIGNING_PRIVATE_KEY=.tauri/comsolpilot.key`
>
> 这也是为什么它默认是关的——先让本地打包流程保持能跑通。

### 7.4 CI 里配上密钥

在仓库 Settings → Secrets and variables → Actions 添加：

| Secret | 值 |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | `.tauri/comsolpilot.key` 的完整内容 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 生成时设的口令（没设就填空字符串） |

然后把 `release.yml` 里那两行被注释掉的 `TAURI_SIGNING_*` 取消注释。

### 7.5 前端加检查

```ts
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

const update = await check();
if (update) {
  await update.downloadAndInstall();
  await relaunch();
}
```

还需要在 `src-tauri/capabilities/default.json` 里放行
`updater:default` 和 `process:allow-restart`。

---

## 8. 常见问题

**`failed to find external binary`**
没跑 `npm run sidecar:build`，或者文件名缺目标三元组后缀。

**MSI 打包卡在下载 WiX**
网络问题。用 `npm run tauri:build:nsis` 只出 NSIS 包。

**安装后任务栏图标是 Electron 的原子图标 / 名字不对**
那是 Electron 外壳的现象（开发态宿主是 `electron.exe`）。
Tauri 打包产物不受影响——它的 `productName`、`identifier`、图标都写进了 exe 元数据。

**`npm run version:check` 报不一致**
跑 `npm run version:sync`。如果是 CI 报的，说明提交前忘了同步。

**`tauri build` 报 signing key not found**
你把 `createUpdaterArtifacts` 打开了但没提供私钥。见 7.3 的说明。
