import { useEffect, useState } from "react";
import { AlertTriangle, Check, Loader2 } from "lucide-react";
import { listClients, registerClients, type McpClient } from "../../lib/api";

interface Props {
  onNext: () => void;
  onBack: () => void;
}

export function ClientSelectStep({ onNext, onBack }: Props) {
  const [clients, setClients] = useState<McpClient[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const list = await listClients();
        setClients(list);
        setSelected(
          new Set(list.filter((client) => client.registered).map((client) => client.id)),
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
      setLoading(false);
    })();
  }, []);

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

  async function handleNext() {
    setSaving(true);
    setError(null);
    try {
      await registerClients(Array.from(selected));
      onNext();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  }

  const available = clients.filter((client) => client.detected);

  return (
    <div className="step-body">
      <h2 className="step-title-sm">接入 AI 客户端</h2>
      <p className="step-subtitle">
        勾选要接入的客户端，只会写入你选中的那些配置文件，写入前会自动备份。
      </p>

      {error && (
        <div className="banner banner-error">
          <AlertTriangle size={16} />
          {error}
        </div>
      )}

      {loading ? (
        <div className="status-card">
          <Loader2 className="spin" size={17} />
          <span>正在检测已安装的客户端…</span>
        </div>
      ) : available.length === 0 ? (
        <div className="status-card status-card-warn">
          <AlertTriangle size={17} />
          <span>本机没有检测到任何受支持的 AI 客户端，可以先跳过，之后再接入。</span>
        </div>
      ) : (
        <div className="client-grid">
          {available.map((client) => (
            <button
              key={client.id}
              className={`client-tile ${selected.has(client.id) ? "is-selected" : ""}`}
              onClick={() => toggle(client.id)}
            >
              <span className="client-tile-check">
                {selected.has(client.id) && <Check size={13} />}
              </span>
              {client.label}
            </button>
          ))}
        </div>
      )}

      <div className="step-actions">
        <button className="btn btn-text" onClick={onBack}>
          上一步
        </button>
        <button className="btn btn-primary" onClick={handleNext} disabled={saving}>
          {saving ? "写入配置…" : "下一步"}
        </button>
      </div>
    </div>
  );
}
