import { useState } from "react";
import {
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
  XCircle,
} from "lucide-react";
import {
  detectComsol,
  pickDirectory,
  restartServer,
  setComsolPath,
  startServer,
  stopServer,
  type AppState,
  type ComsolInfo,
  type ServerStatus,
} from "../lib/api";
import { refreshState, useAppState } from "../lib/appState";

interface Props {
  onOpenClients: () => void;
  onRunSetup: () => void;
}

export function Dashboard({ onOpenClients, onRunSetup }: Props) {
  // 状态来自全局 store：状态栏、功能区也在读同一份，不必各拉一遍接口。
  // 轮询统一由 App 负责。
  const { state, error: linkError } = useAppState();
  const [actionError, setActionError] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"headless" | "gui">("gui");

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

  async function handleDetect() {
    setDetecting(true);
    await run(() => detectComsol());
    setDetecting(false);
  }

  async function handlePick() {
    const directory = await pickDirectory();
    if (!directory) return;
    await run(() => setComsolPath(directory));
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

  const { comsol, deps, server, clients } = state;
  const registered = clients.filter((client) => client.registered).length;
  const detected = clients.filter((client) => client.detected).length;
  const workflow = [
    { id: "workflow-comsol", title: "COMSOL 安装", done: comsol.found },
    { id: "workflow-runtime", title: "运行环境", done: deps.ready },
    { id: "workflow-server", title: "COMSOL Server", done: server.running },
    { id: "workflow-clients", title: "AI 客户端", done: registered > 0 },
  ];
  const currentWorkflowStep = workflow.findIndex((item) => !item.done);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">概览</h1>
          <p className="page-subtitle">COMSOL、运行环境与 AI 客户端的当前状态。</p>
        </div>
        <button className="btn btn-ghost" onClick={() => void refreshState()}>
          <RefreshCw size={15} /> 刷新
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

      <section className="workflow-overview" aria-label="接入进度">
        <div className="workflow-overview-head">
          <div>
            <h2>接入流程</h2>
            <p>{currentWorkflowStep < 0 ? "基础连接已配置，可在 AI 客户端的新对话中调用 COMSOL 工具。" : `下一步：${workflow[currentWorkflowStep].title}`}</p>
          </div>
          <span className="workflow-count">{workflow.filter((item) => item.done).length} / {workflow.length}</span>
        </div>
        <div className="workflow-track">
          {workflow.map((item, index) => (
            <button key={item.id} className={`workflow-step ${item.done ? "is-done" : index === currentWorkflowStep ? "is-current" : ""}`} onClick={() => document.getElementById(item.id)?.scrollIntoView({ behavior: "smooth", block: "center" })}>
              <span className="workflow-step-number">{item.done ? <CheckCircle2 size={16} /> : index + 1}</span>
              <span className="workflow-step-copy"><strong>{item.title}</strong><small>{item.done ? "已完成" : index === currentWorkflowStep ? "当前步骤" : "待处理"}</small></span>
            </button>
          ))}
        </div>
      </section>

      <div className="card-grid">
        <ComsolCard
          comsol={comsol}
          detecting={detecting}
          onDetect={handleDetect}
          onPick={handlePick}
        />

        <EnvironmentCard deps={deps} onRunSetup={onRunSetup} />

        <ServerCard
          server={server}
          mode={mode}
          busy={busy}
          onModeChange={setMode}
          onStart={() => runServerAction(() => startServer(mode))}
          onOpenDesktop={() => runServerAction(() => startServer("gui"))}
          onStop={() => runServerAction(stopServer)}
          onRestart={() => runServerAction(() => restartServer(mode))}
        />

        <ClientsCard
          registered={registered}
          detected={detected}
          total={clients.length}
          onOpen={onOpenClients}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function ComsolCard({
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

function EnvironmentCard({
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
              {deps.interpreter_source === "core-venv"
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
            配置时会先扫描本机是否已有可用的 Python 环境（旧版 COMSOLPilot、conda
            环境等），能复用就直接复用，不会重复下载依赖。
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

function ServerCard({
  server,
  mode,
  busy,
  onModeChange,
  onStart,
  onOpenDesktop,
  onStop,
  onRestart,
}: {
  server: ServerStatus;
  mode: "headless" | "gui";
  busy: boolean;
  onModeChange: (mode: "headless" | "gui") => void;
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

      {starting && (
        <p className="hint" style={{ marginTop: 12 }}>
          JVM 启动通常需要 30-60 秒，请稍候。进度见「日志」页。
        </p>
      )}

      <div className="actions-row">
        {!running && !starting && (
          <>
            <div className="segmented">
              <button
                className={`segmented-item ${mode === "headless" ? "is-active" : ""}`}
                onClick={() => onModeChange("headless")}
              >
                无界面
              </button>
              <button
                className={`segmented-item ${mode === "gui" ? "is-active" : ""}`}
                onClick={() => onModeChange("gui")}
              >
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

function ClientsCard({
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
        AI 客户端
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
          ? "还没有接入任何 AI 客户端。接入后，在客户端里对话就能直接驱动 COMSOL。"
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
