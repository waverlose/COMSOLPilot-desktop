import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import { listClients, registerClients, syncClients, type McpClient } from "../lib/api";

export function ClientsPage({ refreshKey = 0 }: { refreshKey?: number }) {
  const [clients, setClients] = useState<McpClient[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await listClients();
      setClients(list);
      setSelected(new Set(list.filter((client) => client.registered).map((client) => client.id)));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  function toggle(id: string) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  async function handleRegister() {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const response = await registerClients(Array.from(selected));
      setClients(response.clients);
      setMessage(describeResults(response.results));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setBusy(false);
  }

  async function handleSync() {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const response = await syncClients();
      setClients(response.clients);
      setMessage(
        response.results.length === 0
          ? "没有已注册的客户端，无需同步。"
          : describeResults(response.results),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setBusy(false);
  }

  const detectedCount = clients.filter((client) => client.detected).length;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">AI 客户端</h1>
          <p className="page-subtitle">
            勾选要接入的客户端，只会写入你选中的那些配置文件（写入前自动备份为 .bak）。
          </p>
        </div>
        <button className="btn btn-ghost" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw size={15} /> 刷新
        </button>
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

      <div className="card">
        <h2 className="card-title">
          已检测到 {detectedCount} 个客户端
          {busy && <Loader2 className="spin" size={15} />}
        </h2>

        {loading ? (
          <div className="status-card">
            <Loader2 className="spin" size={17} />
            <span>正在检测客户端…</span>
          </div>
        ) : clients.length === 0 ? (
          <div className="empty-state">没有可用的客户端列表。</div>
        ) : (
          <div className="client-list">
            {clients.map((client) => (
              <button
                key={client.id}
                className={[
                  "client-row",
                  selected.has(client.id) ? "is-selected" : "",
                  client.detected ? "" : "is-absent",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onClick={() => toggle(client.id)}
                disabled={!client.detected}
                title={client.detected ? client.path ?? "" : "本机未安装"}
              >
                <span className="client-tile-check">
                  {selected.has(client.id) && <Check size={13} />}
                </span>
                <span className="client-row-main">
                  <span className="client-row-label">{client.label}</span>
                  <span className="client-row-path">
                    {client.detected ? client.path : "本机未安装"}
                  </span>
                </span>
                {client.registered ? (
                  <span className="badge badge-ok">已接入</span>
                ) : client.detected ? (
                  <span className="badge badge-muted">未接入</span>
                ) : (
                  <span className="badge badge-muted">未安装</span>
                )}
              </button>
            ))}
          </div>
        )}

        <div className="actions-row-end">
          <button className="btn btn-ghost" onClick={handleSync} disabled={busy}>
            同步已注册端口
          </button>
          <button className="btn btn-primary" onClick={handleRegister} disabled={busy}>
            {busy ? "写入配置…" : `保存选择（${selected.size}）`}
          </button>
        </div>
      </div>

      <p className="hint" style={{ marginTop: 14 }}>
        写入后需要在客户端里重新信任 / 重启一次连接器，新配置才会生效。
      </p>
    </div>
  );
}

function describeResults(
  results: { client: string; label?: string; action?: string; detail?: string; reason?: string }[],
): string {
  if (results.length === 0) return "没有需要变更的客户端。";

  const changed = results.filter((item) => item.action === "created" || item.action === "updated");
  if (changed.length === 0) {
    const ok = results.filter((item) => item.action === "ok").length;
    return ok > 0 ? `配置已是最新（${ok} 个客户端）。` : "没有需要变更的客户端。";
  }

  const names = changed.map((item) => item.label ?? item.client).join("、");
  return `已写入：${names}。请到对应客户端重新信任连接器。`;
}
