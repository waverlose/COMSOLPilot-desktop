import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, FolderOpen, Loader2, Save } from "lucide-react";
import {
  getSettings,
  listComsolVersions,
  revealDirectory,
  syncClients,
  updateSettings,
  type AppSettings,
  type VersionsResponse,
} from "../lib/api";

const LOGIN_MODES: { value: string; label: string; hint: string }[] = [
  { value: "auto", label: "需要登录（推荐）", hint: "客户端连接前需先在 COMSOL 桌面端登录一次。" },
  { value: "never", label: "不校验登录", hint: "任何本地客户端都能连，仅适合本机自用。" },
  { value: "info", label: "缺信息时才询问", hint: "仅在登录信息缺失时提示。" },
  { value: "force", label: "每次都询问", hint: "每次连接都要求输入登录信息。" },
];

export function SettingsPage({ refreshKey = 0 }: { refreshKey?: number }) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [versions, setVersions] = useState<VersionsResponse | null>(null);
  const [port, setPort] = useState("");
  const [cores, setCores] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const loaded = await getSettings();
        setSettings(loaded);
        setPort(String(loaded.configured_port ?? loaded.port));
        setCores(String(loaded.cores));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
      try {
        setVersions(await listComsolVersions());
      } catch {
        // 版本枚举依赖已安装的核心环境，失败时界面降级为「自动」即可
        setVersions({ available: false, active: "", versions: [] });
      }
    })();
  }, [refreshKey]);

  async function patch(update: Partial<AppSettings>) {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const updated = await updateSettings(update);
      setSettings(updated);
      setPort(String(updated.configured_port ?? updated.port));
      setCores(String(updated.cores));
      setMessage("已保存。");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setBusy(false);
  }

  async function handleSave() {
    const patchBody: Partial<AppSettings> = {};

    const portValue = Number(port);
    if (port.trim() !== "" && Number.isFinite(portValue)) {
      patchBody.port = portValue;
    }
    const coresValue = Number(cores);
    if (cores.trim() !== "" && Number.isFinite(coresValue)) {
      patchBody.cores = coresValue;
    }

    await patch(patchBody);
  }

  async function handleSyncClients() {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const response = await syncClients();
      setMessage(
        response.results.length === 0
          ? "没有已注册的客户端，无需同步。"
          : `已同步 ${response.results.length} 个客户端的端口。`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setBusy(false);
  }

  if (!settings) {
    return (
      <div className="page">
        <h1 className="page-title">设置</h1>
        {error ? (
          <div className="banner banner-error">
            <AlertTriangle size={16} />
            {error}
          </div>
        ) : (
          <div className="status-card">
            <Loader2 className="spin" size={17} />
            <span>正在读取设置…</span>
          </div>
        )}
      </div>
    );
  }

  const versionOptions = versions?.versions ?? [];

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">设置</h1>
          <p className="page-subtitle">
            这些值保存在 core/workspace/settings.json，启动脚本与 MCP 客户端都会读取。
          </p>
        </div>
      </div>

      {error && (
        <div className="banner banner-error">
          <AlertTriangle size={16} />
          {error}
        </div>
      )}
      {message && (
        <div className="banner banner-info">
          <CheckCircle2 size={16} />
          {message}
        </div>
      )}

      <div className="card-grid">
        <div className="card">
          <h2 className="card-title">服务端</h2>

          <div className="field">
            <label className="field-label" htmlFor="port">
              COMSOL 服务端端口
            </label>
            <input
              id="port"
              className="input is-mono"
              value={port}
              onChange={(event) => setPort(event.target.value)}
              inputMode="numeric"
              placeholder="2036"
            />
            <span className="field-hint">
              1024-65535。当前生效端口：{settings.port}。改动后需要重启服务端，
              并点下方「同步已注册客户端」让客户端指向新端口。
            </span>
          </div>

          <div className="field">
            <label className="field-label" htmlFor="cores">
              计算核数
            </label>
            <input
              id="cores"
              className="input is-mono"
              value={cores}
              onChange={(event) => setCores(event.target.value)}
              inputMode="numeric"
              placeholder="0"
            />
            <span className="field-hint">0 表示交给 COMSOL 自行决定。</span>
          </div>

          <div className="field">
            <label className="field-label" htmlFor="login-mode">
              登录模式
            </label>
            <select
              id="login-mode"
              className="select"
              value={settings.login_mode}
              onChange={(event) => void patch({ login_mode: event.target.value })}
            >
              {LOGIN_MODES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <span className="field-hint">
              {LOGIN_MODES.find((option) => option.value === settings.login_mode)?.hint}
            </span>
          </div>
        </div>

        <div className="card">
          <h2 className="card-title">COMSOL 与输出</h2>

          <div className="field">
            <label className="field-label" htmlFor="version">
              COMSOL 版本
            </label>
            <select
              id="version"
              className="select"
              value={settings.comsol_version}
              onChange={(event) => void patch({ comsol_version: event.target.value })}
              disabled={versionOptions.length === 0}
            >
              <option value="">自动（最新安装）</option>
              {versionOptions.map((version) => (
                <option key={version.name} value={version.name}>
                  COMSOL {version.name}
                </option>
              ))}
            </select>
            <span className="field-hint">
              {versionOptions.length === 0
                ? "未能枚举 COMSOL 安装（需要先完成依赖安装）。"
                : "服务端与桌面端会固定在同一个版本上。"}
            </span>
          </div>

          <div className="field">
            <label className="field-label" htmlFor="table-label">
              AI 建表时的标签
            </label>
            <input
              id="table-label"
              className="input"
              value={settings.table_label}
              onChange={(event) => void patch({ table_label: event.target.value })}
              placeholder="留空表示不重命名"
            />
            <span className="field-hint">给 AI 创建的结果表加个可辨认的前缀，留空即保持 COMSOL 原名。</span>
          </div>

          <div className="field">
            <span className="field-label">服务端可执行文件</span>
            <input
              className="input is-mono"
              value={settings.comsol_server_exe || "（自动探测）"}
              readOnly
            />
          </div>

          <div className="field">
            <span className="field-label">Python 解释器</span>
            <input
              className="input is-mono"
              value={settings.python_exe || "（尚未确定）"}
              readOnly
            />
            <span className="field-hint">
              MCP 客户端会用这个解释器启动 COMSOLPilot。可以复用本机已有的环境，
              不必新建。
            </span>
          </div>
        </div>
      </div>

      <div className="actions-row-end">
        <button
          className="btn btn-ghost"
          onClick={() => void revealDirectory(settings.logs_dir)}
        >
          <FolderOpen size={15} /> 打开日志目录
        </button>
        <button className="btn btn-ghost" onClick={handleSyncClients} disabled={busy}>
          同步已注册客户端
        </button>
        <button className="btn btn-primary" onClick={handleSave} disabled={busy}>
          {busy ? <Loader2 className="spin" size={15} /> : <Save size={15} />}
          保存
        </button>
      </div>
    </div>
  );
}
