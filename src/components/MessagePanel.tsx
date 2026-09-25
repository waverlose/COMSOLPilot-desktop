// 底部消息栏。
//
// 对应 COMSOL 主窗口底部的 Messages / Log 面板：不打断当前操作，
// 又能随时瞄一眼后端在说什么。完整版在「消息与日志」页。
import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronUp, ExternalLink, RefreshCw } from "lucide-react";

import { tailLogs } from "../lib/api";
import { onSidecarLog } from "../lib/shell";

const MAX_LINES = 500;

type Source = "sidecar" | "comsol";

interface Props {
  open: boolean;
  onToggle: () => void;
  onOpenLogsPage: () => void;
}

export function MessagePanel({ open, onToggle, onOpenLogsPage }: Props) {
  const [source, setSource] = useState<Source>("sidecar");
  const [sidecarLines, setSidecarLines] = useState<string[]>([]);
  const [comsolLines, setComsolLines] = useState<string[]>([]);
  const [comsolFile, setComsolFile] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // 实时消息由运行时外壳转发（Tauri 事件 / Electron IPC）
  useEffect(() => {
    return onSidecarLog((line) => {
      setSidecarLines((previous) => [...previous, line].slice(-MAX_LINES));
    });
  }, []);

  const loadComsol = useCallback(async () => {
    setLoading(true);
    try {
      const tail = await tailLogs(300);
      setComsolLines(tail.lines);
      setComsolFile(tail.file);
    } catch (error) {
      setComsolLines([`[error] ${error instanceof Error ? error.message : String(error)}`]);
      setComsolFile(null);
    }
    setLoading(false);
  }, []);

  // 只在展开且切到该页签时才去读文件，收起来就别费这个劲
  useEffect(() => {
    if (open && source === "comsol" && comsolLines.length === 0) void loadComsol();
  }, [open, source, comsolLines.length, loadComsol]);

  const lines = source === "sidecar" ? sidecarLines : comsolLines;

  return (
    <div className="bottom-panel">
      <div className="bottom-tabs">
        <button
          className={`bottom-tab ${source === "sidecar" ? "is-active" : ""}`}
          onClick={() => {
            setSource("sidecar");
            if (!open) onToggle();
          }}
        >
          消息{sidecarLines.length > 0 ? ` (${sidecarLines.length})` : ""}
        </button>
        <button
          className={`bottom-tab ${source === "comsol" ? "is-active" : ""}`}
          onClick={() => {
            setSource("comsol");
            if (!open) onToggle();
          }}
          title={comsolFile ?? "COMSOL 服务端启动日志"}
        >
          COMSOL 日志
        </button>

        <span className="bottom-spacer" />

        {open && source === "comsol" && (
          <button className="bottom-toggle" onClick={() => void loadComsol()} disabled={loading}>
            <RefreshCw size={11} className={loading ? "spin" : undefined} /> 重新读取
          </button>
        )}
        {open && (
          <button className="bottom-toggle" onClick={onOpenLogsPage} title="在日志页查看完整内容">
            <ExternalLink size={11} /> 完整日志
          </button>
        )}
        <button className="bottom-toggle" onClick={onToggle}>
          {open ? <ChevronDown size={11} /> : <ChevronUp size={11} />}
          {open ? "收起" : "展开"}
        </button>
      </div>

      {open && (
        <div className="bottom-body">
          {lines.length === 0 ? (
            <div className="log-empty">
              {source === "sidecar"
                ? "暂无消息。启动服务端后，后端的实时输出会显示在这里。"
                : "还没有 COMSOL 服务端日志。启动一次服务端后即可看到。"}
            </div>
          ) : (
            lines.map((line, index) => (
              <div key={index} className="log-line">
                {line}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
