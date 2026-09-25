// Electron 预加载脚本。
//
// 只做一件事：把主进程的能力以**最小接口**挂到 `window.comsolpilot` 上。
// 渲染进程拿不到 Node，也没有 ipcRenderer，能调的只有这里显式暴露的五个方法。
//
// 接口必须与 `src/lib/shell.ts` 里的 `ElectronBridge` 保持一致——那边是唯一
// 的消费方，改这里就要同步改那边。
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

contextBridge.exposeInMainWorld("comsolpilot", {
  getBackendPort: (): Promise<number> => ipcRenderer.invoke("backend:port"),

  getBackendToken: (): Promise<string> => ipcRenderer.invoke("backend:token"),

  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke("dialog:pickDirectory"),

  revealDirectory: (target: string): Promise<void> => ipcRenderer.invoke("shell:reveal", target),

  onSidecarLog: (listener: (line: string) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, line: string) => listener(line);
    ipcRenderer.on("sidecar-log", handler);
    return () => {
      ipcRenderer.removeListener("sidecar-log", handler);
    };
  },

  // --- 自绘窗口按钮 -------------------------------------------------------
  minimizeWindow: (): Promise<void> => ipcRenderer.invoke("window:minimize"),

  toggleMaximizeWindow: (): Promise<boolean> => ipcRenderer.invoke("window:toggleMaximize"),

  closeWindow: (): Promise<void> => ipcRenderer.invoke("window:close"),

  isWindowMaximized: (): Promise<boolean> => ipcRenderer.invoke("window:isMaximized"),

  onWindowMaximized: (listener: (maximized: boolean) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, maximized: boolean) => listener(maximized);
    ipcRenderer.on("window:maximized", handler);
    return () => {
      ipcRenderer.removeListener("window:maximized", handler);
    };
  },
});
