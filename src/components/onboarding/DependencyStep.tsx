import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Download,
  Loader2,
  RefreshCw,
  Recycle,
  XCircle,
} from "lucide-react";
import {
  getDepsStatus,
  listEnvironments,
  streamDependencyInstall,
  useEnvironment,
  type DepsEnvironment,
  type DepsStatus,
} from "../../lib/api";

interface Props {
  onNext: () => void;
  onBack: () => void;
}

type Phase = "discovering" | "choose" | "installing" | "done";

export function DependencyStep({ onNext, onBack }: Props) {
  const [phase, setPhase] = useState<Phase>("discovering");
  const [status, setStatus] = useState<DepsStatus | null>(null);
  const [candidates, setCandidates] = useState<DepsEnvironment[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  const startInstall = useCallback((force: boolean, interpreter?: string) => {
    setPhase("installing");
    setLines([]);
    streamDependencyInstall(
      (line) => setLines((previous) => [...previous, line]),
      (succeeded) => {
        setOk(succeeded);
        setPhase("done");
      },
      { force, interpreter },
    );
  }, []);

  /** 先看本机有没有能直接复用的环境——有就不下载，这是新用户最常见的路径。 */
  const survey = useCallback(
    async (refresh: boolean) => {
      setPhase("discovering");
      try {
        const [deps, envs] = await Promise.all([
          getDepsStatus(refresh),
          listEnvironments(refresh),
        ]);
        setStatus(deps);

        if (deps.ready && deps.interpreter) {
          setOk(true);
          setLines([
            `[info] 已找到可用环境，无需安装`,
            `[info]   解释器：${deps.interpreter}`,
            `[info]   Python ${deps.interpreter_version ?? ""}`,
          ]);
          setPhase("done");
          return;
        }

        if (envs.reusable.length > 0) {
          setCandidates(envs.reusable);
          setSelected(envs.reusable[0].path);
          setPhase("choose");
          return;
        }

        // 一个能用的都没有，只能新建环境再装
        startInstall(false);
      } catch (error) {
        setOk(false);
        setLines([
          `[error] ${error instanceof Error ? error.message : String(error)}`,
        ]);
        setPhase("done");
      }
    },
    [startInstall],
  );

  useEffect(() => {
    void survey(false);
  }, [survey]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [lines]);

  async function handleUse() {
    if (!selected) return;
    setBusy(true);
    try {
      const result = await useEnvironment(selected);
      setOk(true);
      setLines([
        `[info] 已复用环境：${result.environment.path}`,
        `[info]   Python ${result.environment.version}（${result.environment.source_label}）`,
        `[done] 环境就绪，无需安装任何依赖`,
      ]);
      setPhase("done");
    } catch (error) {
      setOk(false);
      setLines([
        `[error] ${error instanceof Error ? error.message : String(error)}`,
      ]);
      setPhase("done");
    }
    setBusy(false);
  }

  return (
    <div className="step-body">
      <h2 className="step-title-sm">配置运行环境</h2>

      {phase === "discovering" && (
        <>
          <p className="step-subtitle">
            先扫描本机是否已有可用的 Python 环境，能复用就不重复安装。
          </p>
          <div className="status-card">
            <Loader2 className="spin" size={17} />
            <span>正在扫描本机的 Python 环境…</span>
          </div>
        </>
      )}

      {phase === "choose" && (
        <>
          <p className="step-subtitle">
            发现本机已有装好依赖的环境，直接复用可以省下几分钟和一份重复的依赖。
          </p>

          <div className="client-list">
            {candidates.map((environment) => (
              <button
                key={environment.path}
                className={`client-row ${selected === environment.path ? "is-selected" : ""}`}
                onClick={() => setSelected(environment.path)}
              >
                <span className="client-tile-check">
                  {selected === environment.path && <Check size={13} />}
                </span>
                <span className="client-row-main">
                  <span className="client-row-label">
                    Python {environment.version} · {environment.source_label}
                  </span>
                  <span className="client-row-path">{environment.path}</span>
                </span>
                <span className="badge badge-ok">依赖齐备</span>
              </button>
            ))}
          </div>

          <div className="step-actions">
            <div className="step-actions-left">
              <button className="btn btn-text" onClick={onBack}>
                上一步
              </button>
              <button className="btn btn-text" onClick={() => void survey(true)}>
                <RefreshCw size={13} /> 重新扫描
              </button>
            </div>
            <div className="step-actions-left">
              <button
                className="btn btn-ghost"
                onClick={() => startInstall(true)}
                disabled={busy}
              >
                <Download size={15} /> 装个干净环境
              </button>
              <button className="btn btn-primary" onClick={handleUse} disabled={busy}>
                {busy ? <Loader2 className="spin" size={15} /> : <Recycle size={15} />}
                使用这个环境
              </button>
            </div>
          </div>
        </>
      )}

      {phase === "installing" && (
        <>
          <p className="step-subtitle">
            没有找到可直接复用的环境，正在新建并安装依赖（首次约 3-5 分钟）。
          </p>
          <div className="log-panel" ref={logRef}>
            {lines.map((line, index) => (
              <div key={index} className="log-line">
                {line}
              </div>
            ))}
            <div className="log-line log-line-active">
              <Loader2 className="spin" size={13} /> 安装中…
            </div>
          </div>
          <div className="step-actions">
            <div className="step-actions-left">
              <button className="btn btn-text" onClick={onBack}>
                上一步
              </button>
            </div>
          </div>
        </>
      )}

      {phase === "done" && (
        <>
          <p className="step-subtitle">
            {ok
              ? "环境已就绪，MCP 客户端会用这个解释器启动 COMSOLPilot。"
              : "环境还没配置成功，可以先跳过，稍后在「概览」页重试。"}
          </p>

          <div className="log-panel" ref={logRef}>
            {lines.map((line, index) => (
              <div key={index} className="log-line">
                {line}
              </div>
            ))}
            {ok ? (
              <div className="log-line log-line-done">
                <CheckCircle2 size={13} /> 环境就绪
              </div>
            ) : (
              <div className="log-line" style={{ color: "#e08a7a" }}>
                <XCircle size={13} /> 未能完成
              </div>
            )}
          </div>

          {status && !ok && (
            <div className="banner banner-warn">
              <AlertTriangle size={16} />
              可以先跳过，到「概览 → 运行环境」里重新配置。
            </div>
          )}

          <div className="step-actions">
            <div className="step-actions-left">
              <button className="btn btn-text" onClick={onBack}>
                上一步
              </button>
              {!ok && (
                <button className="btn btn-text" onClick={() => void survey(true)}>
                  重新扫描
                </button>
              )}
            </div>
            <button className="btn btn-primary" onClick={onNext} disabled={!ok}>
              下一步
            </button>
          </div>
        </>
      )}
    </div>
  );
}
