// 功能区（Ribbon）。
//
// COMSOL 的界面里最显眼的就是这条带选项卡的工具栏，所以这里按同样的组织方式：
// 「选项卡 → 分组 → 大图标按钮」，组与组之间用竖线分隔，组名写在底部。
//
// 所有按钮都接了真实动作（由 App 传下来的 ChromeActions），没有摆设。
import { useState } from "react";
import {
  Activity,
  Boxes,
  FolderSearch,
  LayoutGrid,
  ListTree,
  Monitor,
  Play,
  Plug,
  RefreshCw,
  RotateCw,
  ScrollText,
  Settings2,
  Square,
  Wand2,
  type LucideIcon,
} from "lucide-react";

import type { ChromeActions } from "../types";

interface RibbonButton {
  label: string;
  icon: LucideIcon;
  onClick: () => void;
  disabled?: boolean;
}

interface RibbonGroup {
  label: string;
  buttons: RibbonButton[];
}

interface RibbonTabDef {
  id: string;
  groups: RibbonGroup[];
}

interface Props {
  actions: ChromeActions;
  serverRunning: boolean;
  serverStarting: boolean;
  showTree: boolean;
  onToggleTree: () => void;
}

export function Ribbon({
  actions,
  serverRunning,
  serverStarting,
  showTree,
  onToggleTree,
}: Props) {
  const [active, setActive] = useState("home");

  // 服务端没跑起来时，「停止 / 重启」不该是可点的
  const stopDisabled = !serverRunning || serverStarting;
  const startDisabled = serverRunning || serverStarting;

  const tabs: RibbonTabDef[] = [
    {
      id: "home",
      groups: [
        {
          label: "服务端",
          buttons: [
            {
              label: "启动服务",
              icon: Play,
              onClick: () => actions.startServer("headless"),
              disabled: startDisabled,
            },
            { label: "停止", icon: Square, onClick: actions.stopServer, disabled: stopDisabled },
            {
              label: "重启",
              icon: RotateCw,
              onClick: actions.restartServer,
              disabled: stopDisabled,
            },
          ],
        },
        {
          label: "状态",
          buttons: [
            { label: "刷新状态", icon: RefreshCw, onClick: actions.refresh },
            { label: "检测 COMSOL", icon: Activity, onClick: actions.detectComsol },
          ],
        },
        {
          label: "向导",
          buttons: [{ label: "设置向导", icon: Wand2, onClick: actions.runSetup }],
        },
      ],
    },
    {
      id: "model",
      groups: [
        {
          label: "COMSOL 安装",
          buttons: [
            { label: "重新检测", icon: Boxes, onClick: actions.detectComsol },
            { label: "选择目录…", icon: FolderSearch, onClick: actions.pickComsolPath },
          ],
        },
        {
          label: "运行环境",
          buttons: [{ label: "配置环境", icon: Wand2, onClick: actions.runSetup }],
        },
      ],
    },
    {
      id: "run",
      groups: [
        {
          label: "服务端",
          buttons: [
            {
              label: "无界面启动",
              icon: Play,
              onClick: () => actions.startServer("headless"),
              disabled: startDisabled,
            },
            {
              label: "桌面端启动",
              icon: Monitor,
              onClick: () => actions.startServer("gui"),
              disabled: startDisabled,
            },
            { label: "停止", icon: Square, onClick: actions.stopServer, disabled: stopDisabled },
          ],
        },
        {
          label: "客户端",
          buttons: [{ label: "管理客户端", icon: Plug, onClick: () => actions.navigate("clients") }],
        },
      ],
    },
    {
      id: "view",
      groups: [
        {
          label: "窗口",
          buttons: [
            { label: "概览", icon: LayoutGrid, onClick: () => actions.navigate("dashboard") },
            { label: "客户端", icon: Plug, onClick: () => actions.navigate("clients") },
            { label: "设置", icon: Settings2, onClick: () => actions.navigate("settings") },
            { label: "消息与日志", icon: ScrollText, onClick: () => actions.navigate("logs") },
          ],
        },
        {
          label: "模型开发器",
          buttons: [{ label: showTree ? "隐藏树" : "显示树", icon: ListTree, onClick: onToggleTree }],
        },
      ],
    },
  ];

  const current = tabs.find((tab) => tab.id === active) ?? tabs[0];

  return (
    <div className="ribbon">
      <div className="ribbon-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={`ribbon-tab ${active === tab.id ? "is-active" : ""}`}
            onClick={() => setActive(tab.id)}
          >
            {TAB_LABELS[tab.id] ?? tab.id}
          </button>
        ))}
      </div>

      <div className="ribbon-body">
        {current.groups.map((group, index) => (
          <div key={group.label} style={{ display: "flex", alignItems: "stretch" }}>
            {index > 0 && <div className="ribbon-sep" />}
            <div className="ribbon-group">
              <div className="ribbon-group-buttons">
                {group.buttons.map((button) => (
                  <button
                    key={button.label}
                    className="ribbon-btn"
                    onClick={button.onClick}
                    disabled={button.disabled}
                    title={button.label}
                  >
                    <span className="ribbon-btn-icon">
                      <button.icon size={22} strokeWidth={1.5} />
                    </span>
                    <span className="ribbon-btn-label">{button.label}</span>
                  </button>
                ))}
              </div>
              <div className="ribbon-group-label">{group.label}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const TAB_LABELS: Record<string, string> = {
  home: "主页",
  model: "模型",
  run: "运行",
  view: "视图",
};
