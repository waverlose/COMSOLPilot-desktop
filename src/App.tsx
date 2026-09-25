// 应用外壳与路由。
//
// 布局对齐 COMSOL Multiphysics：
//   标题栏 → 菜单栏 → 功能区 → [模型开发器 | 内容区] → 消息栏 → 状态栏
//
// 三条导航入口（菜单、功能区、模型树）都收敛到这里实现的 `ChromeActions`，
// 保证同一个动作在哪触发行为都一致。
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, X } from "lucide-react";

import { AppMenuBar } from "./components/AppMenuBar";
import { MessagePanel } from "./components/MessagePanel";
import { ModelTree, defaultNodeFor, type TreeNodeDef } from "./components/ModelTree";
import { Ribbon } from "./components/Ribbon";
import { StatusBar } from "./components/StatusBar";
import { OnboardingWizard } from "./components/onboarding/OnboardingWizard";
import { ClientsPage } from "./pages/ClientsPage";
import { Dashboard } from "./pages/Dashboard";
import { LogsPage } from "./pages/LogsPage";
import { SettingsPage } from "./pages/SettingsPage";
import {
  detectComsol,
  pickDirectory,
  restartServer,
  setComsolPath,
  startServer,
  stopServer,
} from "./lib/api";
import { refreshState, useAppState } from "./lib/appState";
import type { ChromeActions, ServerMode, View } from "./types";

const ONBOARDING_DONE_KEY = "comsolpilot.onboarded";
const POLL_INTERVAL = 4000;
const POLL_INTERVAL_STARTING = 1200;

export default function App() {
  const [onboarded, setOnboarded] = useState<boolean>(
    () => localStorage.getItem(ONBOARDING_DONE_KEY) === "true",
  );
  const [view, setView] = useState<View>("dashboard");
  const [treeNode, setTreeNode] = useState<string>(() => defaultNodeFor("dashboard"));
  const [showTree, setShowTree] = useState(true);
  const [showMessages, setShowMessages] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);
  /** 每次全局刷新 +1，页面据此重新拉自己的数据。 */
  const [refreshKey, setRefreshKey] = useState(0);

  const snapshot = useAppState();
  const starting = snapshot.state?.server.starting ?? false;
  const serverRunning = snapshot.state?.server.running ?? false;

  // 外壳轮询：状态栏、功能区、概览页共用这一份数据
  useEffect(() => {
    if (!onboarded) return;
    void refreshState();
    const timer = setInterval(() => void refreshState(), POLL_INTERVAL);
    return () => clearInterval(timer);
  }, [onboarded]);

  // 启动中要盯得更紧，否则用户要等满一个轮询周期才看到状态变化
  useEffect(() => {
    if (!onboarded || !starting) return;
    const timer = setInterval(() => void refreshState(), POLL_INTERVAL_STARTING);
    return () => clearInterval(timer);
  }, [onboarded, starting]);

  const navigate = useCallback((next: View) => {
    setView(next);
    setTreeNode(defaultNodeFor(next));
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

  const actions: ChromeActions = {
    navigate,
    refresh: () => {
      setRefreshKey((key) => key + 1);
      void refreshState();
    },
    runSetup: () => setOnboarded(false),
    detectComsol: () => void runAction(() => detectComsol()),
    pickComsolPath: () =>
      void runAction(async () => {
        const directory = await pickDirectory();
        if (directory) await setComsolPath(directory);
      }),
    startServer: (mode: ServerMode) => void runAction(() => startServer(mode)),
    stopServer: () => void runAction(() => stopServer()),
    restartServer: () => void runAction(() => restartServer()),
    quit: () => {
      try {
        window.close();
      } catch {
        // 某些外壳不允许脚本关窗，忽略即可
      }
    },
  };

  // F5 刷新（菜单里标了这个快捷键，就让它真的能用）
  useEffect(() => {
    if (!onboarded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "F5") {
        event.preventDefault();
        actions.refresh();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // actions.refresh 每次渲染都是新引用，这里刻意不放进依赖，避免反复绑定
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onboarded]);

  if (!onboarded) {
    return (
      <OnboardingWizard
        onComplete={() => {
          localStorage.setItem(ONBOARDING_DONE_KEY, "true");
          setOnboarded(true);
          void refreshState();
        }}
      />
    );
  }

  function handleTreeSelect(node: TreeNodeDef) {
    setTreeNode(node.id);
    setView(node.view);
  }

  return (
    <div className="app-shell">
      <AppMenuBar
        actions={actions}
        showMessages={showMessages}
        onToggleMessages={() => setShowMessages((value) => !value)}
      />

      <Ribbon
        actions={actions}
        serverRunning={serverRunning}
        serverStarting={starting}
        showTree={showTree}
        onToggleTree={() => setShowTree((value) => !value)}
      />

      <div className="app-body">
        {showTree && (
          <ModelTree
            selected={treeNode}
            onSelect={handleTreeSelect}
            onRunSetup={actions.runSetup}
            depsReady={snapshot.state?.deps.ready ?? false}
            serverRunning={serverRunning}
            registeredClients={
              snapshot.state?.clients.filter((client) => client.registered).length ?? 0
            }
          />
        )}

        <main className="app-main">
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
              onRunSetup={actions.runSetup}
            />
          )}
          {view === "clients" && <ClientsPage refreshKey={refreshKey} />}
          {view === "settings" && <SettingsPage refreshKey={refreshKey} />}
          {view === "logs" && <LogsPage refreshKey={refreshKey} />}
        </main>
      </div>

      <MessagePanel
        open={showMessages}
        onToggle={() => setShowMessages((value) => !value)}
        onOpenLogsPage={() => navigate("logs")}
      />

      <StatusBar snapshot={snapshot} />
    </div>
  );
}
