// 模型开发器（左侧树）。
//
// COMSOL 的左栏是一棵「模型树」，选中不同节点、右侧显示对应设置。这里照搬这个交互：
// 树节点既是导航也是选中态，和功能区/菜单栏是三条通往同一批页面的入口。
//
// 节点定义是数据驱动的，加一个页面只要往 TREE 里加一项。
import { useState } from "react";
import {
  Boxes,
  Cpu,
  KeyRound,
  Plug,
  RefreshCw,
  ScrollText,
  Server,
  Settings2,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-react";

import type { View } from "../types";

export interface TreeNodeDef {
  id: string;
  label: string;
  view: View;
  icon: LucideIcon;
  children?: TreeNodeDef[];
}

/** 树的静态结构。第一个 view 匹配到的节点就是该页面的「默认选中项」。 */
export const TREE: TreeNodeDef[] = [
  {
    id: "global",
    label: "全局定义",
    view: "settings",
    icon: Settings2,
    children: [
      { id: "global.basic", label: "基本设置", view: "settings", icon: SlidersHorizontal },
      { id: "global.port", label: "端口与登录", view: "settings", icon: KeyRound },
    ],
  },
  { id: "comsol", label: "COMSOL 安装", view: "dashboard", icon: Boxes },
  { id: "runtime", label: "运行环境", view: "dashboard", icon: Cpu },
  { id: "server", label: "服务端", view: "dashboard", icon: Server },
  { id: "clients", label: "AI 客户端", view: "clients", icon: Plug },
  { id: "logs", label: "消息与日志", view: "logs", icon: ScrollText },
];

/** 给定页面，找出应该高亮的树节点。 */
export function defaultNodeFor(view: View): string {
  for (const node of TREE) {
    if (node.view === view) return node.id;
    const child = node.children?.find((item) => item.view === view);
    if (child) return child.id;
  }
  return TREE[0].id;
}

interface Props {
  selected: string;
  onSelect: (node: TreeNodeDef) => void;
  onRunSetup: () => void;
  depsReady: boolean;
  serverRunning: boolean;
  registeredClients: number;
}

export function ModelTree({
  selected,
  onSelect,
  onRunSetup,
  depsReady,
  serverRunning,
  registeredClients,
}: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function badgeFor(id: string): string | null {
    if (id === "runtime") return depsReady ? "✓" : "!";
    if (id === "server") return serverRunning ? "●" : null;
    if (id === "clients") return registeredClients > 0 ? String(registeredClients) : null;
    return null;
  }

  function renderNode(node: TreeNodeDef, depth: number) {
    const hasChildren = (node.children?.length ?? 0) > 0;
    const isCollapsed = collapsed.has(node.id);
    const badge = badgeFor(node.id);

    return (
      <div key={node.id}>
        <div
          className={`tree-node ${selected === node.id ? "is-active" : ""}`}
          style={{ paddingLeft: 6 + depth * 14 }}
          onClick={() => onSelect(node)}
          role="treeitem"
          aria-selected={selected === node.id}
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onSelect(node);
            }
          }}
        >
          {hasChildren ? (
            <button
              className="tree-toggle"
              onClick={(event) => {
                event.stopPropagation();
                toggle(node.id);
              }}
              aria-label={isCollapsed ? "展开" : "折叠"}
            >
              {isCollapsed ? "▶" : "▼"}
            </button>
          ) : (
            <span className="tree-toggle" />
          )}

          <span className="tree-icon">
            <node.icon size={13} strokeWidth={1.6} />
          </span>
          <span className="tree-label">{node.label}</span>
          {badge && <span className="tree-badge">{badge}</span>}
        </div>

        {hasChildren && !isCollapsed && node.children?.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  }

  return (
    <aside className="model-tree">
      <div className="model-tree-header">模型开发器</div>
      <div className="model-tree-body" role="tree">
        {TREE.map((node) => renderNode(node, 0))}
      </div>
      <div className="model-tree-footer">
        <button onClick={onRunSetup}>
          <RefreshCw size={12} strokeWidth={1.75} />
          <span>重新运行设置向导</span>
        </button>
      </div>
    </aside>
  );
}
