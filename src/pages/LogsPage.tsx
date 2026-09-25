import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { tailLogs } from "../lib/api";
import { onSidecarLog } from "../lib/shell";

type Source = "sidecar" | "comsol";

const MAX_LINES = 800;

export function LogsPage({ refreshKey = 0 }: { refreshKey?: number }) {
  const [source, setSource] = useState<Source>("sidecar");
  const [sidecarLines, setSidecarLines] = useState<string[]>([]);
  const [comsolLines, setComsolLines] = useState<string[]>([]);
  const [comsolFile, setComsolFile] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // 实时日志由运行时外壳转发（Tauri 事件 / Electron IPC）；
    // 浏览器里调界面时没有这条通道，返回的取消函数是空操作。
    return onSidecarLog((line) => {
      setSidecarLines((previous) => [...previous, line].slice(-MAX_LINES));
    });
  }, []);

  const loadComsolLog = useCallback(async () => {
    setLoading(true);
    try {
      const tail = await tailLogs(400);
      setComsolLines(tail.lines);
      setComsolFile(tail.file);
    } catch (error) {
      setComsolLines([`[error] ${error instanceof Error ? error.message : String(error)}`]);
      setComsolFile(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (source === "comsol" && comsolLines.length === 0) {
      void loadComsolLog();
    }
  }, [source, comsolLines.length, loadComsolLog]);

  // 全局刷新（菜单/功能区/F5）时重新读一次日志文件
  useEffect(() => {
    if (refreshKey > 0) void loadComsolLog();
  }, [refreshKey, loadComsolLog]);

  const lines = source === "sidecar" ? sidecarLines : comsolLines;

  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [lines]);

  return (
    <div className="page page-fill">
      <div className="page-header">
        <div>
          <h1 className="page-title">日志</h1>
          <p className="page-subtitle">
            本地服务的实时输出，以及 COMSOL 服务端自己写的启动日志。
          </p>
        </div>
      </div>

      <div className="log-toolbar">
        <div className="segmented">
          <button
            className={`segmented-item ${source === "sidecar" ? "is-active" : ""}`}
            onClick={() => setSource("sidecar")}
          >
            本地服务输出
          </button>
          <button
            className={`segmented-item ${source === "comsol" ? "is-active" : ""}`}
            onClick={() => setSource("comsol")}
          >
            COMSOL 服务端日志
          </button>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
          {source === "comsol" && comsolFile && (
            <span className="log-file" title={comsolFile}>
              {comsolFile}
            </span>
          )}
          {source === "comsol" && (
            <button className="btn btn-ghost" onClick={() => void loadComsolLog()} disabled={loading}>
              <RefreshCw size={15} /> 重新读取
            </button>
          )}
        </div>
      </div>

      <div className="log-panel log-panel-fill" ref={ref}>
        {lines.length === 0 && (
          <div className="log-empty">
            {source === "sidecar"
              ? "暂无输出。启动服务端后，这里的实时日志会显示出来。"
              : "还没有 COMSOL 服务端日志。启动一次服务端后即可看到。"}
          </div>
        )}
        {lines.map((line, index) => (
          <div key={index} className="log-line">
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}
