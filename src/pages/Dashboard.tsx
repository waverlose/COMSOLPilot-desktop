import { useState } from "react";
import {
  ArrowRight,
  AlertTriangle,
  CheckCircle2,
  FolderSearch,
  Loader2,
  Monitor,
  Play,
  Plug,
  RefreshCw,
  RotateCw,
  Server,
  Square,
  Stethoscope,
  XCircle,
} from "lucide-react";
import {
  getDiagnostics,
  restartServer,
  startServer,
  stopServer,
  type AppState,
  type ComsolInfo,
  type DiagnosticsResponse,
  type ServerStatus,
} from "../lib/api";
import { refreshState, useAppState } from "../lib/appState";

interface Props {
  onOpenClients: () => void;
}

export function Dashboard({ onOpenClients }: Props) {
  // 状态来自全局 store：状态栏、功能区也在读同一份，不必各拉一遍接口。
  // 轮询统一由 App 负责。
  const { state, error: linkError } = useAppState();
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"headless" | "gui">("gui");
  const [diagnostics, setDiagnostics] = useState<DiagnosticsResponse | null>(null);
  const [diagnosticsBusy, setDiagnosticsBusy] = useState(false);

  async function openDiagnostics() {
    setDiagnosticsBusy(true);
    try {
      setDiagnostics(await getDiagnostics());
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setDiagnosticsBusy(false);
    }
  }

  const fatal = actionError ?? linkError;

  /** 动作失败就地记下来——refreshState 成功后会把链路错误清掉，这里不能混用。 */
  async function run(action: () => Promise<unknown>) {
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
    await refreshState();
  }

  async function runServerAction(action: () => Promise<ServerStatus>) {
    setBusy(true);
    await run(action);
    setBusy(false);
  }

  if (!state) {
    return (
      <div className="page">
        <h1 className="page-title">概览</h1>
        {fatal ? (
          <div className="banner banner-error">
            <AlertTriangle size={16} />
            连接本地服务失败：{fatal}
          </div>
        ) : (
          <div className="status-card">
            <Loader2 className="spin" size={17} />
            <span>正在连接本地服务…</span>
          </div>
        )}
      </div>
    );
  }

  const { server } = state;
  return (
    <div className="page dashboard-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">概览</h1>
        </div>
        <button className="btn btn-ghost" onClick={() => void refreshState()}>
          <RefreshCw size={15} /> 刷新
        </button>
        <button className="btn btn-secondary" onClick={() => void openDiagnostics()} disabled={diagnosticsBusy}>
          {diagnosticsBusy ? <Loader2 className="spin" size={15} /> : <Stethoscope size={15} />} 连接诊断
        </button>
      </div>

      {fatal && (
        <div className="banner banner-error">
          <AlertTriangle size={16} />
          {fatal}
        </div>
      )}

      {server.error && (
        <div className="banner banner-warn">
          <AlertTriangle size={16} />
          {server.error}
        </div>
      )}

      <div className="card-grid dashboard-control-grid">
        <ServerCard
          server={server}
          mode={mode}
          onModeChange={setMode}
          busy={busy}
          onStart={() => runServerAction(() => startServer(mode))}
          onOpenDesktop={() => runServerAction(() => startServer("gui"))}
          onStop={() => runServerAction(stopServer)}
          onRestart={() => runServerAction(() => restartServer(mode))}
        />
      </div>
      {diagnostics && <DiagnosticsDialog report={diagnostics} busy={diagnosticsBusy} onRefresh={() => void openDiagnostics()} onClose={() => setDiagnostics(null)} onClients={onOpenClients} />}
    </div>
  );
}

// ---------------------------------------------------------------------------

function DiagnosticsDialog({ report, busy, onRefresh, onClose, onClients }: { report: DiagnosticsResponse; busy: boolean; onRefresh: () => void; onClose: () => void; onClients: () => void }) {
  const actionFor = (id: string) => id === "clients"
    ? <button className="btn btn-ghost btn-sm" onClick={onClients}>管理客户端 <ArrowRight size={13} /></button> : null;
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
    <section className="dialog diagnostics-dialog" role="dialog" aria-modal="true" aria-labelledby="diagnostics-title">
      <div className="dialog-header"><div><h2 id="diagnostics-title"><Stethoscope size={18} /> 连接诊断</h2><p>{report.ok ? "所有基础连接均已就绪" : "发现需要处理的项目"}</p></div><button className="btn btn-ghost btn-sm" onClick={onClose}>关闭</button></div>
      <div className="diagnostics-list">{report.checks.map((check) => <div className={`diagnostic-row ${check.ok ? "is-ok" : "is-fail"}`} key={check.id}>{check.ok ? <CheckCircle2 size={17} /> : <XCircle size={17} />}<div className="diagnostic-copy"><strong>{check.label}</strong><span>{check.detail}</span>{check.value && <code>{check.value}</code>}</div>{actionFor(check.id)}</div>)}</div>
      {report.core && <div className="diagnostics-core"><span>COMSOLPilot Core {report.core.version}</span><span>{report.core.tool_count == null ? "工具数不可用" : `${report.core.tool_count} 个工具`}</span></div>}
      <div className="dialog-footer"><button className="btn btn-secondary" onClick={onRefresh} disabled={busy}>{busy ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />} 重新检查</button><button className="btn btn-ghost" onClick={onClose}>完成</button></div>
    </section>
  </div>;
}

export function ComsolCard({
  comsol,
  detecting,
  onDetect,
  onPick,
}: {
  comsol: ComsolInfo;
  detecting: boolean;
  onDetect: () => void;
  onPick: () => void;
}) {
  return (
    <div className="card" id="workflow-comsol">
      <h2 className="card-title">
        COMSOL 安装
        {comsol.found ? (
          <span className="badge badge-ok">
            <CheckCircle2 size={12} /> 已找到
          </span>
        ) : (
          <span className="badge badge-warn">
            <XCircle size={12} /> 未找到
          </span>
        )}
      </h2>

      {comsol.found ? (
        <div className="info-list">
          <div className="info-row">
            <span className="info-label">版本</span>
            <span className="info-value">{comsol.version || "未知"}</span>
          </div>
          <div className="info-row">
            <span className="info-label">安装目录</span>
            <span className="info-value is-mono">{comsol.path || "—"}</span>
          </div>
          <div className="info-row">
            <span className="info-label">来源</span>
            <span className="info-value">{describeSource(comsol.source)}</span>
          </div>
        </div>
      ) : (
        <p className="hint">
          没有自动找到 COMSOL。可以先点「重新检测」，或手动指定安装目录
          （选择包含 Multiphysics 的那一层，例如 D:\COMSOL60）。
        </p>
      )}

      <div className="actions-row">
        <button className="btn btn-secondary" onClick={onDetect} disabled={detecting}>
          {detecting ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
          {detecting ? "检测中…" : "重新检测"}
        </button>
        <button className="btn btn-ghost" onClick={onPick}>
          <FolderSearch size={15} /> 手动选择目录
        </button>
      </div>
    </div>
  );
}

function describeSource(source?: string | null): string {
  if (source === "settings") return "设置中指定";
  if (source === "manual") return "手动选择";
  if (source === "mph") return "自动探测（MPh）";
  return "—";
}

// ---------------------------------------------------------------------------

export function EnvironmentCard({
  deps,
  onRunSetup,
}: {
  deps: AppState["deps"];
  onRunSetup: () => void;
}) {
  return (
    <div className="card" id="workflow-runtime">
      <h2 className="card-title">
        运行环境
        {deps.ready ? (
          <span className="badge badge-ok">
            <CheckCircle2 size={12} /> 就绪
          </span>
        ) : (
          <span className="badge badge-warn">
            <XCircle size={12} /> 待安装
          </span>
        )}
      </h2>

      <div className="info-list">
        <div className="info-row">
          <span className="info-label">解释器</span>
          <span className="info-value is-mono">{deps.interpreter ?? "尚未确定"}</span>
        </div>
        {deps.ready && (
          <div className="info-row">
            <span className="info-label">来源</span>
            <span className="info-value">
              {deps.interpreter_source === "bundled-runtime"
                ? "安装包内置环境"
                : deps.interpreter_source === "core-venv"
                ? "本应用新建的环境"
                : deps.reusable[0]?.source_label ?? "本机已有环境"}
              {deps.interpreter_version ? `（Python ${deps.interpreter_version}）` : ""}
            </span>
          </div>
        )}
        <div className="info-row">
          <span className="info-label">依赖</span>
          <span className="info-value">
            {deps.ready
              ? "全部就位"
              : deps.missing.length > 0
                ? `缺少 ${deps.missing.join("、")}`
                : "未配置"}
          </span>
        </div>
        <div className="info-row">
          <span className="info-label">核心目录</span>
          <span className="info-value is-mono">{deps.core_root}</span>
        </div>
      </div>

      {!deps.ready && (
        <>
          <p className="hint" style={{ marginTop: 12 }}>
            安装包自带运行环境；如环境缺失，可以在设置中选择已有环境。
          </p>
          <div className="actions-row">
            <button className="btn btn-primary" onClick={onRunSetup}>
              去配置环境
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function startupStage(server: ServerStatus): string {
  const text = server.log_tail.join(" ").toLowerCase();
  if (text.includes("desktop") || text.includes("gui")) return "正在打开 COMSOL 桌面";
  if (text.includes("listening") || text.includes("started")) return "服务已监听，正在确认连接";
  return "正在启动 COMSOL JVM";
}

function ServerCard({
  server,
  mode,
  onModeChange,
  busy,
  onStart,
  onOpenDesktop,
  onStop,
  onRestart,
}: {
  server: ServerStatus;
  mode: "headless" | "gui";
  onModeChange: (mode: "headless" | "gui") => void;
  busy: boolean;
  onStart: () => void;
  onOpenDesktop: () => void;
  onStop: () => void;
  onRestart: () => void;
}) {
  const { running, starting } = server;

  return (
    <div className="card" id="workflow-server">
      <h2 className="card-title">
        COMSOL 服务端
        <span className={`badge ${running ? "badge-ok" : starting ? "badge-accent" : "badge-muted"}`}>
          {starting && <Loader2 className="spin" size={12} />}
          {running ? "运行中" : starting ? "启动中…" : "已停止"}
        </span>
      </h2>

      <div className="info-list">
        <div className="info-row">
          <span className="info-label">端口</span>
          <span className="info-value is-mono">{server.port}</span>
        </div>
        {running && server.uptime_seconds != null && (
          <div className="info-row">
            <span className="info-label">已运行</span>
            <span className="info-value">{formatUptime(server.uptime_seconds)}</span>
          </div>
        )}
        {running && server.pid ? (
          <div className="info-row">
            <span className="info-label">进程</span>
            <span className="info-value is-mono">PID {server.pid}</span>
          </div>
        ) : null}
      </div>

      {starting && <p className="server-stage"><strong>{startupStage(server)}</strong></p>}
      {starting && (
        <p className="hint" style={{ marginTop: 12 }}>
          JVM 启动通常需要 30-60 秒，请稍候。进度见「日志」页。
        </p>
      )}

      <div className="actions-row">
        {!running && !starting && (
          <>
            <div className="segmented" aria-label="启动模式">
              <button className={`segmented-item ${mode === "headless" ? "is-active" : ""}`} onClick={() => onModeChange("headless")}>
                无界面
              </button>
              <button className={`segmented-item ${mode === "gui" ? "is-active" : ""}`} onClick={() => onModeChange("gui")}>
                打开桌面端
              </button>
            </div>
            <button className="btn btn-primary" onClick={onStart} disabled={busy}>
              <Play size={15} /> 启动服务
            </button>
          </>
        )}

        {running && (
          <>
            <button className="btn btn-primary" onClick={onOpenDesktop} disabled={busy}>
              <Monitor size={15} /> 打开 COMSOL 桌面
            </button>
            <button className="btn btn-secondary" onClick={onStop} disabled={busy}>
              <Square size={15} /> 停止
            </button>
            <button className="btn btn-ghost" onClick={onRestart} disabled={busy}>
              <RotateCw size={15} /> 重启
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function ClientsCard({
  registered,
  detected,
  total,
  onOpen,
}: {
  registered: number;
  detected: number;
  total: number;
  onOpen: () => void;
}) {
  return (
    <div className="card" id="workflow-clients">
      <h2 className="card-title">
        客户端
        <Plug size={15} strokeWidth={1.75} color="var(--ink-muted)" />
      </h2>

      <div className="info-list">
        <div className="info-row">
          <span className="info-label">已接入</span>
          <span className="info-value">{registered} 个</span>
        </div>
        <div className="info-row">
          <span className="info-label">已检测</span>
          <span className="info-value">
            {detected} / {total} 个
          </span>
        </div>
      </div>

      <p className="hint" style={{ marginTop: 12 }}>
        {registered === 0
          ? "还没有接入客户端。接入后，在客户端里对话就能直接驱动 COMSOL。"
          : "新增或调整接入的客户端，改动会立刻写入对应的配置文件。"}
      </p>

      <div className="actions-row">
        <button className="btn btn-secondary" onClick={onOpen}>
          <Server size={15} /> 管理客户端
        </button>
      </div>
    </div>
  );
}

function formatUptime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
  if (minutes > 0) return `${minutes} 分钟`;
  return `${Math.floor(seconds)} 秒`;
}
