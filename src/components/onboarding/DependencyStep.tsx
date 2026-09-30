import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Download,
  FolderOpen,
  Loader2,
  RefreshCw,
  Recycle,
  XCircle,
} from "lucide-react";
import {
  getDepsStatus,
  listEnvironments,
  pickDirectory,
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

  /** The installer runtime is ready without a separate download. */
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
            `[info] ${deps.interpreter_source === "bundled-runtime" ? "安装包内置环境已就绪" : "已找到可用环境"}，无需安装`,
            `[info]   解释器：${deps.interpreter}`,
            `[info]   Python ${deps.interpreter_version ?? ""}`,
          ]);
          setPhase("done");
          return;
        }

        setCandidates(envs.reusable);
        setSelected(envs.reusable[0]?.path ?? null);
        setPhase("choose");
      } catch (error) {
        setOk(false);
        setLines([
          `[error] ${error instanceof Error ? error.message : String(error)}`,
        ]);
        setPhase("done");
      }
    },
    [],
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

  async function handlePickEnvironment() {
    const folder = await pickDirectory();
    if (!folder) return;
    setBusy(true);
    try {
      await useEnvironment(folder);
      setOk(true);
      setLines([`[info] 已选择环境目录：${folder}`, "[done] 环境就绪"]);
      setPhase("done");
    } catch (error) {
      setOk(false);
      setLines([`[error] ${error instanceof Error ? error.message : String(error)}`]);
      setPhase("done");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="step-body">
      <h2 className="step-title-sm">配置运行环境</h2>

      {phase === "discovering" && (
        <>
          <p className="step-subtitle">
            正在检查软件运行环境。
          </p>
          <div className="status-card">
            <Loader2 className="spin" size={17} />
            <span>正在检查运行环境…</span>
          </div>
        </>
      )}

      {phase === "choose" && (
        <>
          <p className="step-subtitle">
            选择已有的完整 Python 环境，或在软件核心目录下创建环境并下载依赖。
          </p>

          {candidates.length > 0 && <div className="client-list">
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
          </div>}
          {candidates.length === 0 && <p className="hint">没有找到依赖齐全的环境。可以选择其他环境目录，或由软件创建。</p>}

          {status?.core_root && (
            <p className="field-hint">
              软件管理环境位置：{status.core_root}\\.venv
            </p>
          )}

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
              <button className="btn btn-ghost" onClick={() => void handlePickEnvironment()} disabled={busy}>
                <FolderOpen size={15} /> 选择环境目录
              </button>
              {selected && <button className="btn btn-primary" onClick={handleUse} disabled={busy}>
                {busy ? <Loader2 className="spin" size={15} /> : <Recycle size={15} />}
                使用这个环境
              </button>}
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
            <div className="step-actions-left">
              {!ok && <button className="btn btn-text" onClick={onNext}>稍后配置</button>}
              <button className="btn btn-primary" onClick={onNext} disabled={!ok}>下一步</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
