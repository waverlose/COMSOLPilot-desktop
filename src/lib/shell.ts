// 运行时外壳抽象层。
//
// 同一份 React 界面要能在三种环境里跑，业务代码只认这里导出的函数，
// 不直接碰任何一个外壳的 API：
//
//   1. **Tauri 窗口**   —— 原生命令走 `@tauri-apps/api`
//   2. **Electron 窗口** —— 预加载脚本把能力挂在 `window.comsolpilot`
//   3. **纯浏览器**      —— `npm run dev` 只调界面时没有原生能力，
//                          端口/令牌从 `VITE_SIDECAR_PORT` / `VITE_SIDECAR_TOKEN` 读
//
// 三者对上层暴露同一组语义：拿端口、拿令牌、选目录、打开目录、订阅日志。

export type ShellKind = "tauri" | "electron" | "browser";

/** Electron 预加载脚本注入到 `window.comsolpilot` 上的桥。 */
export interface ElectronBridge {
  getBackendPort(): Promise<number>;
  getBackendToken(): Promise<string>;
  pickDirectory(): Promise<string | null>;
  revealDirectory(path: string): Promise<void>;
  /** 订阅 sidecar 的实时输出，返回取消订阅函数。 */
  onSidecarLog(listener: (line: string) => void): () => void;
  minimizeWindow(): Promise<void>;
  toggleMaximizeWindow(): Promise<boolean>;
  closeWindow(): Promise<void>;
  isWindowMaximized(): Promise<boolean>;
  onWindowMaximized(listener: (maximized: boolean) => void): () => void;
}

export interface UpdateCheck {
  available: boolean;
  version?: string;
  date?: string;
  notes?: string;
  reason?: string;
}

let pendingTauriUpdate: { downloadAndInstall: () => Promise<void> } | null = null;

export async function checkForUpdates(): Promise<UpdateCheck> {
  switch (shellKind()) {
    case "tauri": {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      pendingTauriUpdate = update ? { downloadAndInstall: () => update.downloadAndInstall() } : null;
      return update
        ? { available: true, version: update.version, date: update.date ?? undefined, notes: update.body ?? undefined }
        : { available: false };
    }
    case "electron":
      return { available: false, reason: "Electron 仅用于兼容开发，正式更新请使用 Tauri 版本" };
    default:
      return { available: false, reason: "browser" };
  }
}

export async function installUpdate(): Promise<void> {
  switch (shellKind()) {
    case "tauri": {
      if (!pendingTauriUpdate) throw new Error("没有可安装的更新");
      await pendingTauriUpdate.downloadAndInstall();
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
      return;
    }
    case "electron":
      throw new Error("Electron 仅用于兼容开发，正式更新请使用 Tauri 版本");
    default:
      throw new Error("浏览器模式不支持安装更新");
  }
}

declare global {
  interface Window {
    comsolpilot?: ElectronBridge;
  }
}

export function shellKind(): ShellKind {
  if (typeof window === "undefined") return "browser";
  if ("__TAURI_INTERNALS__" in window) return "tauri";
  if (window.comsolpilot !== undefined) return "electron";
  return "browser";
}

/** 是否跑在带原生能力的窗口里（Tauri 或 Electron）。 */
export function hasNativeShell(): boolean {
  return shellKind() !== "browser";
}

/** 是否跑在 Tauri 窗口里。保留这个判断给需要区分两种外壳的少数场景。 */
export function isTauri(): boolean {
  return shellKind() === "tauri";
}

export function isElectron(): boolean {
  return shellKind() === "electron";
}

// ---------------------------------------------------------------------------
// 端口与令牌
// ---------------------------------------------------------------------------

let portPromise: Promise<number> | null = null;
let tokenPromise: Promise<string> | null = null;

/**
 * sidecar 监听的端口。
 *
 * Tauri / Electron 都是每次启动随机挑一个空闲端口，所以只能问外壳；
 * 浏览器里没有外壳，退回固定端口，方便手动起后端联调。
 */
export function getBackendPort(): Promise<number> {
  if (portPromise === null) {
    portPromise = (async () => {
      switch (shellKind()) {
        case "tauri": {
          const { invoke } = await import("@tauri-apps/api/core");
          return invoke<number>("get_backend_port");
        }
        case "electron":
          return window.comsolpilot!.getBackendPort();
        default:
          return Number(import.meta.env.VITE_SIDECAR_PORT ?? "8765");
      }
    })();
  }
  return portPromise;
}

/**
 * 本地接口令牌。
 *
 * 只绑回环地址还不够——浏览器里任意网页都能向 127.0.0.1 发请求。每个请求都要带
 * `X-COMSOLPILOT-TOKEN`，外壳每次启动重新生成，猜不到就调不动接口。
 */
export function getBackendToken(): Promise<string> {
  if (tokenPromise === null) {
    tokenPromise = (async () => {
      switch (shellKind()) {
        case "tauri": {
          const { invoke } = await import("@tauri-apps/api/core");
          return invoke<string>("get_backend_token").catch(() => "");
        }
        case "electron":
          return window.comsolpilot!.getBackendToken().catch(() => "");
        default:
          return (import.meta.env.VITE_SIDECAR_TOKEN as string | undefined) ?? "";
      }
    })();
  }
  return tokenPromise;
}

// ---------------------------------------------------------------------------
// 原生能力
// ---------------------------------------------------------------------------

/** 原生文件夹选择器，用于 COMSOL 自动探测失败时的手动兜底。 */
export function pickDirectory(): Promise<string | null> {
  switch (shellKind()) {
    case "tauri":
      return import("@tauri-apps/api/core").then(({ invoke }) =>
        invoke<string | null>("pick_directory"),
      );
    case "electron":
      return window.comsolpilot!.pickDirectory();
    default:
      // 浏览器里没有原生选择器，返回 null 让调用方安静地什么都不做
      return Promise.resolve(null);
  }
}

/** 在系统文件管理器里打开一个目录。 */
export function revealDirectory(path: string): Promise<void> {
  switch (shellKind()) {
    case "tauri":
      return import("@tauri-apps/api/core").then(({ invoke }) =>
        invoke<void>("reveal_directory", { path }),
      );
    case "electron":
      return window.comsolpilot!.revealDirectory(path);
    default:
      return Promise.resolve();
  }
}

/**
 * 订阅 sidecar 的实时输出（日志页用）。
 *
 * 返回取消订阅函数。Tauri 的 `listen` 是异步返回的，这里包一层把它变成同步取消，
 * 免得调用方在 effect 清理里还要 await。
 */
export function onSidecarLog(listener: (line: string) => void): () => void {
  switch (shellKind()) {
    case "electron":
      return window.comsolpilot!.onSidecarLog(listener);
    case "tauri": {
      let disposed = false;
      let unlisten: (() => void) | null = null;
      void import("@tauri-apps/api/event")
        .then(({ listen }) =>
          listen<string>("sidecar-log", (event) => listener(event.payload)),
        )
        .then((dispose) => {
          if (disposed) dispose();
          else unlisten = dispose;
        })
        .catch(() => {
          // 拿不到事件通道就算了，日志页还有「重新读取」这条兜底
        });
      return () => {
        disposed = true;
        unlisten?.();
      };
    }
    default:
      return () => {};
  }
}

// ---------------------------------------------------------------------------
// 自绘窗口按钮
// ---------------------------------------------------------------------------
//
// 窗口是无边框的（Electron 的 `frame: false` / Tauri 的 `decorations: false`），
// 最小化/最大化/关闭得界面上自己画。浏览器里没有窗口可控制，全部降级成空操作，
// 自绘按钮也就不会渲染（见 windowControlsAvailable）。

/** 当前外壳是否提供窗口控制。浏览器里为 false，界面据此隐藏那三个按钮。 */
export function windowControlsAvailable(): boolean {
  return shellKind() !== "browser";
}

export function minimizeWindow(): Promise<void> {
  switch (shellKind()) {
    case "tauri":
      return import("@tauri-apps/api/window").then(({ getCurrentWindow }) =>
        getCurrentWindow().minimize(),
      );
    case "electron":
      return window.comsolpilot!.minimizeWindow();
    default:
      return Promise.resolve();
  }
}

/** 切换最大化，返回切换后的状态。 */
export function toggleMaximizeWindow(): Promise<boolean> {
  switch (shellKind()) {
    case "tauri":
      return import("@tauri-apps/api/window").then(({ getCurrentWindow }) =>
        getCurrentWindow().toggleMaximize().then(() => getCurrentWindow().isMaximized()),
      );
    case "electron":
      return window.comsolpilot!.toggleMaximizeWindow();
    default:
      return Promise.resolve(false);
  }
}

export function closeWindow(): Promise<void> {
  switch (shellKind()) {
    case "tauri":
      return import("@tauri-apps/api/window").then(({ getCurrentWindow }) =>
        getCurrentWindow().close(),
      );
    case "electron":
      return window.comsolpilot!.closeWindow();
    default:
      return Promise.resolve();
  }
}

export function isWindowMaximized(): Promise<boolean> {
  switch (shellKind()) {
    case "tauri":
      return import("@tauri-apps/api/window").then(({ getCurrentWindow }) =>
        getCurrentWindow().isMaximized(),
      );
    case "electron":
      return window.comsolpilot!.isWindowMaximized();
    default:
      return Promise.resolve(false);
  }
}

/** 订阅最大化状态变化，返回取消订阅函数。 */
export function onWindowMaximizedChange(listener: (maximized: boolean) => void): () => void {
  switch (shellKind()) {
    case "electron":
      return window.comsolpilot!.onWindowMaximized(listener);
    case "tauri": {
      // Tauri 没有专门的 maximize 事件，退化成「尺寸变化后重新问一次」。
      // 拖动窗口边缘也会触发，多问几次无害。
      let disposed = false;
      let unlisten: (() => void) | null = null;
      void import("@tauri-apps/api/window")
        .then(({ getCurrentWindow }) =>
          getCurrentWindow().onResized(() => {
            void getCurrentWindow()
              .isMaximized()
              .then(listener)
              .catch(() => {});
          }),
        )
        .then((dispose) => {
          if (disposed) dispose();
          else unlisten = dispose;
        })
        .catch(() => {
          // 拿不到事件通道就算了，按钮图标最多不跟着变
        });
      return () => {
        disposed = true;
        unlisten?.();
      };
    }
    default:
      return () => {};
  }
}
