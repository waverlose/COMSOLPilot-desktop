// Electron 主进程：COMSOLPilot 的第二种桌面外壳。
//
// 与 `src-tauri/` 那套职责完全对等——窗口、原生对话框、端口与令牌、Python sidecar
// 的生命周期。**业务逻辑一概不在这里**，它只做「系统能力 + 编排」，和 Rust 版一一对应：
//
//   | 能力             | Tauri (Rust)                    | Electron (Node)            |
//   | ---------------- | ------------------------------- | -------------------------- |
//   | 挑空闲端口        | portpicker::pick_unused_port    | net.createServer 监听 0 端口 |
//   | 生成令牌          | RandomState 取 128 位            | crypto.randomBytes(16)     |
//   | 拉起 sidecar      | Command::new(python) / externalBin | spawn(...)              |
//   | 转发日志          | emit("sidecar-log")             | webContents.send(...)      |
//   | 原生选目录        | tauri_plugin_dialog             | dialog.showOpenDialog      |
//   | 在资源管理器打开   | explorer / open / xdg-open      | shell.openPath             |
//
// 两种外壳共用同一份 React 界面和同一个 Python 后端，可以按需二选一发布。
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { BrowserWindow, Menu, Tray, app, dialog, ipcMain, nativeImage, net, protocol, shell } from "electron";

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL ?? "http://localhost:5173";
const FALLBACK_PORT = 8765;

/**
 * 应用身份。**必须和 electron-builder.yml / tauri.conf.json 里的值一致**，
 * 否则装出来是 COMSOLPilot、跑起来任务栏却写 Electron。
 *
 * Windows 认的是 AppUserModelID：不显式设置时它退回可执行文件自带的元数据，
 * 而开发态的宿主进程就是 electron.exe（FileDescription = "Electron"），
 * 于是任务栏、通知、固定到开始菜单全都显示 Electron。
 */
const APP_NAME = "COMSOLPilot";
const APP_ID = "com.waverlose.comsolpilot";

/** 打包态页面走这个自定义协议，而不是 file://（原因见 loadFrontend）。 */
const APP_SCHEME = "app";
const APP_ORIGIN = `${APP_SCHEME}://localhost`;
const APP_INDEX = `${APP_ORIGIN}/index.html`;

// 这两句要在 app ready 之前、任何 getPath("userData") 之前执行：
// 名字决定了 %APPDATA% 下的数据目录名，晚了就分叉出两个目录。
app.setName(APP_NAME);
if (process.platform === "win32") app.setAppUserModelId(APP_ID);

/**
 * 窗口/任务栏图标。
 *
 * 不设的话 Electron 会用自带的原子图标——这是最显眼的「这玩意是 Electron」的破绽。
 * 开发态直接用 Tauri 那份图标资源（已经在仓库里了，不重复存一份）；
 * 打包态由 electron-builder.yml 的 extraResources 复制到 resources/ 下。
 */
function appIcon(): string | undefined {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, "icon.ico"), path.join(process.resourcesPath, "icon.png")]
    : [path.join(app.getAppPath(), "src-tauri", "icons", "icon.ico")];
  return candidates.find((candidate) => existsSync(candidate));
}

// 必须在 app ready 之前声明：standard 让它有正常的 origin 语义（能发 CORS 预检），
// secure 让它被当作可信来源，supportFetchAPI 允许页面里 fetch。
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let sidecarChild: ChildProcess | null = null;
let sidecarPort = FALLBACK_PORT;
let sidecarToken = "";

// ---------------------------------------------------------------------------
// 端口与令牌
// ---------------------------------------------------------------------------

/**
 * 让操作系统分配一个空闲端口。
 *
 * 做法是先监听 0 端口问内核要一个，再立刻关掉——和 Tauri 的 portpicker 同思路。
 * 中间存在极短的竞争窗口，但概率极低，且端口真被占了后端会启动失败并写进日志，
 * 比硬编码 8765 撞上用户已有的服务要好。
 */
function pickPort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.unref();
    probe.on("error", () => resolve(FALLBACK_PORT));
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : FALLBACK_PORT;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * 本地接口令牌。
 *
 * 只绑回环地址还不够：浏览器里任意网页都能向 127.0.0.1 发请求，只是读不到响应。
 * 每次启动生成一个猜不到的令牌，前端所有请求都要带上，这才构成一道闸。
 */
function makeToken(): string {
  return randomBytes(16).toString("hex");
}

// ---------------------------------------------------------------------------
// sidecar 生命周期
// ---------------------------------------------------------------------------

/**
 * 开发态挑一个能跑后端的 Python。
 *
 * **不能只挑「能执行」的**：机器上通常有好几个 python，PATH 里第一个往往没有
 * fastapi/uvicorn，拉起来立刻 `ModuleNotFoundError` 退出，界面看着就是「后端连不上」，
 * 而且报错藏在日志里很难联想到解释器选错了。所以这里逐个**真去 import 一下**。
 *
 * 优先级：`COMSOLPILOT_PYTHON` 环境变量 > `sidecar-python.json`（npm run sidecar:setup
 * 写下的）> 常见的三个命令名。第一个装齐依赖的直接返回；一个都没有就返回最可能可用的
 * 那个，并让 startSidecar 把补救命令打进日志。
 */
function recordedPython(): string | null {
  const file = path.join(app.getAppPath(), "sidecar-python.json");
  try {
    if (!existsSync(file)) return null;
    const parsed: unknown = JSON.parse(readFileSync(file, "utf-8"));
    const value = (parsed as { python?: unknown }).python;
    return typeof value === "string" && value.trim() !== "" ? value : null;
  } catch {
    return null;
  }
}

function pythonCandidates(): string[] {
  const explicit = process.env.COMSOLPILOT_PYTHON;
  const list: string[] = [];
  if (explicit !== undefined && explicit.trim() !== "") list.push(explicit);

  const recorded = recordedPython();
  if (recorded !== null && !list.includes(recorded)) list.push(recorded);

  for (const candidate of ["python", "py", "python3"]) {
    if (!list.includes(candidate)) list.push(candidate);
  }
  return list;
}

function probePython(command: string, args: string[]): boolean {
  try {
    const probe = spawnSync(command, args, { stdio: "ignore", shell: false, timeout: 15000 });
    return !probe.error && probe.status === 0;
  } catch {
    return false;
  }
}

const SIDECAR_IMPORTS = "import fastapi, uvicorn, pydantic";

function devPython(): string {
  const candidates = pythonCandidates();

  // 第一轮：解释器能跑，且依赖齐——这是唯一「能真正启动后端」的答案
  for (const candidate of candidates) {
    if (probePython(candidate, ["-c", SIDECAR_IMPORTS])) return candidate;
  }

  // 第二轮：退而求其次，至少返回一个能跑的解释器，让用户看到真实的报错
  for (const candidate of candidates) {
    if (probePython(candidate, ["--version"])) return candidate;
  }
  return "python";
}

/** 组装 sidecar 的启动命令：开发态跑脚本，打包态跑随包的可执行文件。 */
function sidecarInvocation(port: number, token: string): {
  command: string;
  args: string[];
  cwd: string;
} {
  const args = ["--port", String(port), "--token", token];

  if (app.isPackaged) {
    const exe = path.join(process.resourcesPath, "sidecar", "comsolpilot-sidecar.exe");
    return { command: exe, args, cwd: path.dirname(exe) };
  }

  // 开发态：项目根就是 app.getAppPath()（package.json 所在目录）
  const root = app.getAppPath();
  const sidecarDir = path.join(root, "python-sidecar");
  return {
    command: devPython(),
    args: [path.join(sidecarDir, "sidecar_server.py"), ...args],
    cwd: sidecarDir,
  };
}

/** 把子进程输出同时打到终端和渲染进程的日志页。 */
function emitLog(line: string): void {
  try {
    process.stdout.write(`${line}\n`);
  } catch {
    // 打包态没有控制台，忽略
  }
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("sidecar-log", line);
  }
}

/** 子进程的 data 事件不保证按行到达，这里按行切分并缓存残缺的那一行。 */
function makeLineForwarder(): (chunk: string) => void {
  let pending = "";
  return (chunk: string) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim() !== "") emitLog(line);
    }
  };
}

async function startSidecar(): Promise<void> {
  sidecarPort = await pickPort();
  sidecarToken = makeToken();

  const { command, args, cwd } = sidecarInvocation(sidecarPort, sidecarToken);

  if (app.isPackaged && !existsSync(command)) {
    emitLog(`[sidecar] 找不到后端可执行文件：${command}`);
    emitLog("[sidecar] 请先运行 npm run sidecar:build 再打包");
    return;
  }

  // 开发态先验一次依赖。缺 fastapi 的话后端起不来，而那段 traceback 埋在日志里
  // 很不显眼，不如在这里直接说清楚该怎么办。
  if (!app.isPackaged && !probePython(command, ["-c", SIDECAR_IMPORTS])) {
    emitLog(`[sidecar] 警告：${command} 缺少 fastapi/uvicorn/pydantic，后端多半起不来。`);
    emitLog("[sidecar] 补救：用装了这些依赖的解释器启动，例如");
    emitLog("[sidecar]   set COMSOLPILOT_PYTHON=D:\\path\\to\\python.exe && npm run electron:start");
    emitLog("[sidecar] 或者执行 npm run sidecar:setup 让本工程自动挑一个并补齐依赖");
  }

  emitLog(`[sidecar] 启动：${command} ${args.join(" ")}`);

  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  sidecarChild = child;

  const forward = makeLineForwarder();
  child.stdout?.setEncoding("utf-8");
  child.stderr?.setEncoding("utf-8");
  child.stdout?.on("data", (chunk: string) => forward(chunk));
  child.stderr?.on("data", (chunk: string) => forward(chunk));

  child.on("error", (error) => {
    emitLog(`[sidecar] 启动失败：${error.message}`);
  });
  child.on("exit", (code, signal) => {
    emitLog(`[sidecar] 已退出（code=${code ?? "-"}，signal=${signal ?? "-"}）`);
    sidecarChild = null;
  });
}

/** 退出前回收子进程，避免留下孤儿 Python。 */
function stopSidecar(): void {
  if (sidecarChild === null) return;
  try {
    sidecarChild.kill();
  } catch {
    // 已经自己退出了
  }
  sidecarChild = null;
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------

/**
 * 把打包好的前端挂到一个自定义协议上。
 *
 * **不能用 `file://`**，两个原因：
 *   1. `file://` 页面里 `<script type="module">` 会被 Chromium 的 CORS 拦掉，
 *      vite 打出来的入口恰好就是 module script，页面直接白屏；
 *   2. `file://` 的 Origin 是 `null`，而 sidecar 的 CORS 白名单是按 origin 匹配的，
 *      所有 `/api` 请求都会失败。
 *
 * 换成 `app://localhost` 两点同时解决：有正常 origin，模块脚本也能加载。
 * 对应地，`python-sidecar/sidecar_server.py` 的白名单里加了这条 origin。
 */
function registerAppProtocol(): void {
  const distRoot = path.join(app.getAppPath(), "dist");

  protocol.handle(APP_SCHEME, (request) => {
    const { pathname } = new URL(request.url);
    const relative = pathname === "/" || pathname === "" ? "index.html" : pathname.slice(1);
    const target = path.resolve(distRoot, relative);

    // 防目录穿越：解析后必须仍在 dist 目录内
    if (target !== distRoot && !target.startsWith(distRoot + path.sep)) {
      return new Response("Forbidden", { status: 403 });
    }
    return net.fetch(pathToFileURL(target).toString());
  });
}

/**
 * 探一下 dev server 起没起。
 *
 * 刻意用**裸 TCP 连接**而不是 net.fetch / http.request：
 *   * 前者走系统代理设置，本机端口被代理拦掉时会挂住或返回 5xx，判断不可靠；
 *   * 后者在连接被拒时才快速失败，但同样受 proxy 环境变量影响。
 * 只连一下端口、连上就关，既快又不看任何中间人的脸色。
 */
function devServerAlive(): Promise<boolean> {
  return new Promise((resolve) => {
    let url: URL;
    try {
      url = new URL(DEV_SERVER_URL);
    } catch {
      resolve(false);
      return;
    }

    const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
    const socket = createConnection({ host: url.hostname, port });

    const finish = (alive: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(alive);
    };

    socket.setTimeout(800);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/**
 * 决定窗口加载什么。
 *
 * 开发态优先连 vite（有热更新）。但 **vite 没起时不能就这么白屏**——直接 loadURL
 * 会抛 ERR_CONNECTION_REFUSED，窗口一片空白，看起来像「应用坏了」。
 * 所以退一步：只要 `npm run build` 出过 dist/，就改从 app:// 加载构建产物，
 * 并在日志里说清「你看到的是构建版，要热更新请跑 npm run electron:dev」。
 */
async function loadFrontend(window: BrowserWindow): Promise<void> {
  if (app.isPackaged) {
    await window.loadURL(APP_INDEX);
    return;
  }

  // `npm run electron:dev` 会并行拉起 vite，给它最多 12 秒
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await devServerAlive()) {
      await window.loadURL(DEV_SERVER_URL);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  const distIndex = path.join(app.getAppPath(), "dist", "index.html");
  if (existsSync(distIndex)) {
    emitLog("[electron] 没连上 vite 开发服务器（localhost:5173），改加载 dist/ 构建产物。");
    emitLog("[electron] 需要热更新请用 npm run electron:dev。");
    await window.loadURL(APP_INDEX);
    return;
  }

  emitLog("[electron] 没连上 vite，也没有 dist/ 构建产物，窗口会是空的。");
  emitLog("[electron] 先执行 npm run build，或者用 npm run electron:dev。");
  await window.loadURL(DEV_SERVER_URL);
}

async function createWindow(): Promise<void> {
  const icon = appIcon();

  mainWindow = new BrowserWindow({
    width: 940,
    height: 640,
    minWidth: 760,
    minHeight: 520,
    title: APP_NAME,
    backgroundColor: "#f0f0f0",
    show: false,
    // 自绘标题栏。系统那条件框会和界面里的 COMSOL 风格标题栏叠成两条，
    // 而且它显示的名字/图标由操作系统决定，不受我们控制。
    frame: false,
    ...(icon !== undefined ? { icon } : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow?.hide();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // 最大化状态要同步给渲染进程，自绘按钮才知道该画「最大化」还是「还原」
  const pushMaximized = () => {
    if (mainWindow === null || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("window:maximized", mainWindow.isMaximized());
  };
  mainWindow.on("maximize", pushMaximized);
  mainWindow.on("unmaximize", pushMaximized);

  // 菜单栏去掉后 DevTools 没有默认快捷键了，这里补 F12 / Ctrl+Shift+I。
  // 只挂 before-input-event，不用 globalShortcut——后者是系统级的，会抢别的程序。
  mainWindow.webContents.on("before-input-event", (_event, input) => {
    if (input.type !== "keyDown") return;
    const isF12 = input.key === "F12";
    const isInspect = input.control && input.shift && input.key.toLowerCase() === "i";
    if (isF12 || isInspect) mainWindow?.webContents.toggleDevTools();
  });

  await loadFrontend(mainWindow);
}

// ---------------------------------------------------------------------------
// IPC：与 Rust 侧的同名命令一一对应
// ---------------------------------------------------------------------------

function registerIpc(): void {
  ipcMain.handle("backend:port", () => sidecarPort);
  ipcMain.handle("backend:token", () => sidecarToken);

  // --- 自绘窗口按钮 -------------------------------------------------------
  // 窗口是无边框的，最小化/最大化/关闭只能自己接。每个 handler 都用
  // fromWebContents 反查窗口，而不是直接闭包 mainWindow——多窗口时不会串。
  const windowOf = (event: Electron.IpcMainInvokeEvent) =>
    BrowserWindow.fromWebContents(event.sender);

  ipcMain.handle("window:minimize", (event) => {
    windowOf(event)?.hide();
  });

  ipcMain.handle("window:toggleMaximize", (event) => {
    const window = windowOf(event);
    if (window === null) return false;
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
    return window.isMaximized();
  });

  ipcMain.handle("window:close", (event) => {
    windowOf(event)?.close();
  });

  ipcMain.handle("window:isMaximized", (event) => windowOf(event)?.isMaximized() ?? false);

  ipcMain.handle("dialog:pickDirectory", async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      title: "选择 COMSOL 安装目录",
      properties: ["openDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle("shell:reveal", async (_event, target: string): Promise<void> => {
    if (!existsSync(target)) throw new Error(`目录不存在：${target}`);
    const error = await shell.openPath(target);
    if (error !== "") throw new Error(error);
  });
}

function createTray(): void {
  if (tray !== null) return;
  const iconPath = appIcon();
  if (!iconPath) return;
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip("COMSOLPilot");
  const showWindow = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  };
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开 COMSOLPilot", click: showWindow },
    { type: "separator" },
    { label: "退出 COMSOLPilot", click: () => { isQuitting = true; app.quit(); } },
  ]));
  tray.on("click", showWindow);
  tray.on("double-click", showWindow);
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

// 单实例：两个窗口会各自拉起一个 sidecar，抢同一个 COMSOL 端口
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow === null) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  void app.whenReady().then(async () => {
    // 干掉 Electron 自带的英文菜单栏（File / Edit / View / Window / Help）。
    // 界面里已经有一套 COMSOL 风格的中文菜单，留着它既重复又一眼看出是 Electron。
    // 代价是 DevTools 的默认快捷键没了，下面单独补回来。
    Menu.setApplicationMenu(null);

    registerIpc();
    registerAppProtocol();
    createTray();
    await startSidecar();
    await createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow();
    });
  });

  app.on("window-all-closed", () => {
    // Keep the tray process and MCP sidecar alive while the window is hidden.
  });

  app.on("before-quit", () => { isQuitting = true; });
  app.on("before-quit", stopSidecar);
  app.on("will-quit", stopSidecar);
}
