// 应用外壳与路由。
//
// 布局对齐 COMSOL Multiphysics：
//   标题栏 → 菜单栏 → 功能区 → [模型开发器 | 内容区] → 消息栏 → 状态栏
//
// 三条导航入口（菜单、功能区、模型树）都收敛到这里实现的 `ChromeActions`，
// 保证同一个动作在哪触发行为都一致。
import { useCallback, useEffect, useState } from "react";
import {
  Activity, AlertTriangle, Boxes, LayoutDashboard, Minus, Plug, ScrollText,
  Settings2, X,
} from "lucide-react";
import appIcon from "../src-tauri/icons/icon.png";

import { OnboardingWizard } from "./components/onboarding/OnboardingWizard";
import { ClientsPage } from "./pages/ClientsPage";
import { Dashboard } from "./pages/Dashboard";
import { LogsPage } from "./pages/LogsPage";
import { SettingsPage } from "./pages/SettingsPage";
import {
  startServer,
  stopServer,
} from "./lib/api";
import { refreshState, useAppState } from "./lib/appState";
import { closeWindow, minimizeWindow, shellKind } from "./lib/shell";
import type { View } from "./types";

const ONBOARDING_DONE_KEY = "comsolpilot.onboarded";
const POLL_INTERVAL = 4000;
const POLL_INTERVAL_STARTING = 1200;

export default function App() {
  const [setupOpen, setSetupOpen] = useState<boolean>(
    () => localStorage.getItem(ONBOARDING_DONE_KEY) !== "true",
  );
  const [view, setView] = useState<View>("dashboard");
  const [actionError, setActionError] = useState<string | null>(null);
  /** 每次全局刷新 +1，页面据此重新拉自己的数据。 */
  const [refreshKey, setRefreshKey] = useState(0);

  const snapshot = useAppState();
  const starting = snapshot.state?.server.starting ?? false;
  const serverRunning = snapshot.state?.server.running ?? false;

  // 外壳轮询：状态栏、功能区、概览页共用这一份数据
  useEffect(() => {
    void refreshState();
    const timer = setInterval(() => void refreshState(), POLL_INTERVAL);
    return () => clearInterval(timer);
  }, []);

  // 启动中要盯得更紧，否则用户要等满一个轮询周期才看到状态变化
  useEffect(() => {
    if (!starting) return;
    const timer = setInterval(() => void refreshState(), POLL_INTERVAL_STARTING);
    return () => clearInterval(timer);
  }, [starting]);

  const navigate = useCallback((next: View) => {
    setView(next);
  }, []);

  /** 统一兜住动作里的异常：报错显示在内容区顶部，不弹 alert。 */
  const runAction = useCallback(async (action: () => Promise<unknown>) => {
    try {
      await action();
      setActionError(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
    await refreshState();
  }, []);

  // F5 刷新（菜单里标了这个快捷键，就让它真的能用）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "F5") {
        event.preventDefault();
        setRefreshKey((key) => key + 1);
        void refreshState();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const closeSetup = () => {
    localStorage.setItem(ONBOARDING_DONE_KEY, "true");
    localStorage.setItem("comsolpilot.setupStep", "0");
    setSetupOpen(false);
    void refreshState();
  };

  const navItems: { id: View; label: string; icon: typeof LayoutDashboard }[] = [
    { id: "dashboard", label: "概览", icon: LayoutDashboard },
    { id: "clients", label: "AI 客户端", icon: Plug },
    { id: "logs", label: "运行日志", icon: ScrollText },
    { id: "settings", label: "设置", icon: Settings2 },
  ];
  const viewTitle = navItems.find((item) => item.id === view)?.label ?? "概览";

  return (
    <div className="workspace-shell">
      <aside className="workspace-sidebar">
        <div className="brand-lockup">
          <img src={appIcon} alt="" />
          <div><strong>COMSOLPilot</strong><span>DESKTOP</span></div>
        </div>
        <div className="nav-caption">工作区</div>
        <nav className="workspace-nav" aria-label="主导航">
          {navItems.map(({ id, label, icon: Icon }) => (
            <button key={id} className={`workspace-nav-item ${view === id ? "is-active" : ""}`} onClick={() => navigate(id)}>
              <Icon size={17} strokeWidth={1.8} /><span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-status"><span className={`status-indicator ${serverRunning ? "is-online" : ""}`} /><div><strong>{starting ? "正在启动" : serverRunning ? "服务运行中" : "服务已停止"}</strong><small>{snapshot.state?.comsol.found ? `COMSOL ${snapshot.state.comsol.version ?? ""}` : "未检测到 COMSOL"}</small></div></div>
          <button className="setup-link" onClick={() => setSetupOpen(true)}><Boxes size={15} />开始引导</button>
        </div>
      </aside>
      <section className="workspace-main">
        <header className="workspace-header">
          <div className="header-title"><span>COMSOLPilot</span><b>/</b><strong>{viewTitle}</strong></div>
          <div className="header-actions">
            <span className="header-connection"><span className={`status-indicator ${serverRunning ? "is-online" : ""}`} />{serverRunning ? "已连接" : starting ? "连接中" : "未连接"}</span>
            <button className="icon-action" title="刷新状态" aria-label="刷新状态" onClick={() => { setRefreshKey((key) => key + 1); void refreshState(); }}><Activity size={16} /></button>
          {!serverRunning && <button className="btn btn-primary header-start" disabled={starting} onClick={() => void runAction(() => startServer("gui"))}>{starting ? "正在启动…" : "启动 COMSOL"}</button>}
            {serverRunning && <button className="btn btn-secondary header-start" onClick={() => void runAction(() => stopServer())}>停止服务</button>}
            {shellKind() !== "browser" && <div className="app-window-actions"><button className="window-action" title="最小化到托盘" aria-label="最小化到托盘" onClick={() => void minimizeWindow()}><Minus size={15} /></button><button className="window-action window-action-close" title="关闭到托盘" aria-label="关闭到托盘" onClick={() => void closeWindow()}><X size={16} /></button></div>}
          </div>
        </header>
        <main className="workspace-content">
          {actionError && (
            <div className="banner banner-error" style={{ margin: "12px 20px 0" }}>
              <AlertTriangle size={15} />
              <span style={{ flex: 1 }}>{actionError}</span>
              <button className="btn btn-ghost" onClick={() => setActionError(null)}>
                <X size={13} />
              </button>
            </div>
          )}

          {view === "dashboard" && (
            <Dashboard
              onOpenClients={() => navigate("clients")}
              onRunSetup={() => setSetupOpen(true)}
            />
          )}
          {view === "clients" && <ClientsPage refreshKey={refreshKey} />}
          {view === "settings" && <SettingsPage refreshKey={refreshKey} onOpenSetup={() => setSetupOpen(true)} />}
          {view === "logs" && <LogsPage refreshKey={refreshKey} />}
        </main>
      </section>
      {setupOpen && <OnboardingWizard onComplete={closeSetup} onClose={closeSetup} />}
    </div>
  );
}
