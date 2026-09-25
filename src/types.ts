export type View = "dashboard" | "clients" | "settings" | "logs";

export type ServerMode = "headless" | "gui";

/**
 * 外壳（菜单栏、功能区、状态栏）能触发的动作。
 *
 * 由 `App` 实现后向下传——外壳组件只负责画按钮，不直接碰接口，
 * 这样「菜单项」「功能区按钮」「页面内按钮」三处入口共用同一套逻辑。
 */
export interface ChromeActions {
  navigate: (view: View) => void;
  refresh: () => void;
  runSetup: () => void;
  detectComsol: () => void;
  pickComsolPath: () => void;
  startServer: (mode: ServerMode) => void;
  stopServer: () => void;
  restartServer: () => void;
  quit: () => void;
}
