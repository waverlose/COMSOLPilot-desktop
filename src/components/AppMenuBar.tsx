// 标题栏 + 菜单栏。
//
// 菜单是「真」的：每一项都接到了一个动作或视图切换，没有摆样子的死项。
// 之所以把标题栏也放这里，是因为两者在视觉上是一条连续的灰条。
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Check, Copy, Minus, Square, X } from "lucide-react";

import appIcon from "../assets/app-icon.png";
import {
  closeWindow,
  isWindowMaximized,
  minimizeWindow,
  onWindowMaximizedChange,
  toggleMaximizeWindow,
  windowControlsAvailable,
} from "../lib/shell";
import type { ChromeActions } from "../types";

interface MenuEntry {
  label?: string;
  shortcut?: string;
  run?: () => void;
  disabled?: boolean;
  divider?: boolean;
  checked?: boolean;
}

interface Menu {
  id: string;
  label: string;
  entries: MenuEntry[];
}

interface Props {
  actions: ChromeActions;
  showMessages: boolean;
  onToggleMessages: () => void;
}

export function AppMenuBar({ actions, showMessages, onToggleMessages }: Props) {
  const [open, setOpen] = useState<string | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // 窗口是无边框的，最大化状态只有外壳知道，这里同步一份给按钮画图标用
  useEffect(() => {
    if (!windowControlsAvailable()) return;
    void isWindowMaximized().then(setMaximized);
    return onWindowMaximizedChange(setMaximized);
  }, []);

  // 点别处或按 Esc 收起菜单（桌面软件的常规行为）
  useEffect(() => {
    if (open === null) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(null);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const menus: Menu[] = [
    {
      id: "file",
      label: "文件",
      entries: [
        { label: "重新运行设置向导", run: actions.runSetup },
        { label: "刷新状态", shortcut: "F5", run: actions.refresh },
        { divider: true },
        { label: "退出", run: actions.quit },
      ],
    },
    {
      id: "view",
      label: "视图",
      entries: [
        { label: "概览", run: () => actions.navigate("dashboard") },
        { label: "AI 客户端", run: () => actions.navigate("clients") },
        { label: "设置", run: () => actions.navigate("settings") },
        { label: "消息与日志", run: () => actions.navigate("logs") },
        { divider: true },
        { label: "显示消息栏", checked: showMessages, run: onToggleMessages },
      ],
    },
    {
      id: "tools",
      label: "工具",
      entries: [
        { label: "重新检测 COMSOL", run: actions.detectComsol },
        { label: "手动指定 COMSOL 目录…", run: actions.pickComsolPath },
        { divider: true },
        { label: "启动服务端（无界面）", run: () => actions.startServer("headless") },
        { label: "启动服务端（桌面端）", run: () => actions.startServer("gui") },
        { label: "停止服务端", run: actions.stopServer },
        { label: "重启服务端", run: actions.restartServer },
      ],
    },
    {
      id: "help",
      label: "帮助",
      entries: [{ label: "关于 COMSOLPilot", run: () => setAboutOpen(true) }],
    },
  ];

  function runEntry(entry: MenuEntry) {
    if (entry.disabled) return;
    setOpen(null);
    entry.run?.();
  }

  return (
    <>
      <div className="titlebar" data-tauri-drag-region>
        <img className="titlebar-mark" src={appIcon} alt="" width={16} height={16} draggable={false} />
        <span className="titlebar-title">COMSOLPilot</span>
        <span className="titlebar-sub">— AI 驱动的 COMSOL 控制台</span>
        <span className="titlebar-spacer" />

        {windowControlsAvailable() && (
          <div className="titlebar-controls">
            <button
              className="titlebar-control"
              title="最小化"
              onClick={() => void minimizeWindow()}
            >
              <Minus size={13} />
            </button>
            <button
              className="titlebar-control"
              title={maximized ? "向下还原" : "最大化"}
              onClick={() => void toggleMaximizeWindow().then(setMaximized)}
            >
              {maximized ? <Copy size={11} /> : <Square size={10} />}
            </button>
            <button
              className="titlebar-control is-close"
              title="关闭"
              onClick={() => void closeWindow()}
            >
              <X size={13} />
            </button>
          </div>
        )}
      </div>

      <div className="menubar" ref={rootRef}>
        {menus.map((menu) => (
          <div className="menu-root" key={menu.id}>
            <button
              className={`menu-item ${open === menu.id ? "is-open" : ""}`}
              onClick={() => setOpen((previous) => (previous === menu.id ? null : menu.id))}
              onMouseEnter={() => setOpen((previous) => (previous === null ? null : menu.id))}
            >
              {menu.label}
            </button>

            {open === menu.id && (
              <div className="menu-dropdown">
                {menu.entries.map((entry, index) =>
                  entry.divider ? (
                    <div className="menu-divider" key={`divider-${index}`} />
                  ) : (
                    <button
                      className="menu-entry"
                      key={entry.label}
                      onClick={() => runEntry(entry)}
                      disabled={entry.disabled}
                    >
                      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        {entry.checked !== undefined && (
                          <span style={{ width: 11, display: "inline-flex" }}>
                            {entry.checked && <Check size={11} />}
                          </span>
                        )}
                        {entry.label}
                      </span>
                      {entry.shortcut && (
                        <span className="menu-entry-shortcut">{entry.shortcut}</span>
                      )}
                    </button>
                  ),
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {aboutOpen && (
        <div className="menu-dropdown" style={ABOUT_STYLE} onClick={(e) => e.stopPropagation()}>
          <div style={ABOUT_HEAD_STYLE}>
            <span>关于 COMSOLPilot</span>
            <button className="btn btn-ghost" style={ABOUT_CLOSE_STYLE} onClick={() => setAboutOpen(false)}>
              <X size={12} />
            </button>
          </div>
          <div style={ABOUT_BODY_STYLE}>
            <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
              <img
                src={appIcon}
                alt=""
                width={44}
                height={44}
                draggable={false}
                style={{ flexShrink: 0 }}
              />
              <div>
                <p style={{ margin: "0 0 8px" }}>
                  <strong>COMSOLPilot 桌面端</strong> — 把「检测 COMSOL / 配置环境 / 接入 AI
                  客户端 / 启停服务端」这几件命令行活儿，收成点几下就能完成。
                </p>
                <p style={{ margin: 0, color: "var(--ink-muted)" }}>
                  核心 COMSOL 自动化逻辑沿用 COMSOLPilot 项目，界面与外壳是本工程新增的。
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// 关于对话框：一个居中的小面板，不引第三方弹窗库
const ABOUT_STYLE: CSSProperties = {
  position: "fixed",
  top: "50%",
  left: "50%",
  transform: "translate(-50%, -50%)",
  minWidth: 360,
  maxWidth: 440,
  zIndex: 200,
};

const ABOUT_HEAD_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "5px 8px",
  background: "linear-gradient(180deg, #2a7cba 0%, #16659f 100%)",
  color: "#fff",
  fontSize: 12,
  fontWeight: 600,
};

const ABOUT_CLOSE_STYLE: CSSProperties = {
  padding: "0 4px",
  minHeight: 18,
  color: "#fff",
};

const ABOUT_BODY_STYLE: CSSProperties = {
  padding: "12px 14px",
  fontSize: 12,
  lineHeight: 1.65,
};
