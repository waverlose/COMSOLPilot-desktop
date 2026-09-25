import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, FolderSearch, Loader2, XCircle } from "lucide-react";
import { detectComsol, pickDirectory, setComsolPath, type ComsolInfo } from "../../lib/api";

interface Props {
  onNext: () => void;
  onBack: () => void;
}

type Phase = "scanning" | "found" | "not-found";

export function ComsolDetectStep({ onNext, onBack }: Props) {
  const [phase, setPhase] = useState<Phase>("scanning");
  const [info, setInfo] = useState<ComsolInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    detectComsol()
      .then((result) => {
        if (!alive) return;
        setInfo(result);
        setPhase(result.found ? "found" : "not-found");
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setError(err instanceof Error ? err.message : String(err));
        setPhase("not-found");
      });
    return () => {
      alive = false;
    };
  }, []);

  async function handlePick() {
    const directory = await pickDirectory();
    if (!directory) return;

    setError(null);
    try {
      const result = await setComsolPath(directory);
      setInfo(result);
      setPhase(result.found ? "found" : "not-found");
    } catch (err) {
      // 后端会校验目录里是否真的有 comsolmphserver.exe，失败时给出明确原因
      setError(err instanceof Error ? err.message : String(err));
      setPhase("not-found");
    }
  }

  return (
    <div className="step-body">
      <h2 className="step-title-sm">检测 COMSOL 安装</h2>
      <p className="step-subtitle">
        依次扫描设置记录、上次手动指定的目录，以及注册表和常见安装位置。
      </p>

      {phase === "scanning" && (
        <div className="status-card">
          <Loader2 className="spin" size={17} />
          <span>正在扫描系统（首次可能需要十几秒）…</span>
        </div>
      )}

      {phase === "found" && info && (
        <div className="status-card status-card-ok">
          <CheckCircle2 size={17} />
          <div>
            <div className="status-card-title">找到 COMSOL {info.version ?? ""}</div>
            <div className="status-card-path">{info.path}</div>
          </div>
        </div>
      )}

      {phase === "not-found" && (
        <div className="status-card status-card-warn">
          <XCircle size={17} />
          <span>没有自动找到 COMSOL，请手动选择安装目录。</span>
        </div>
      )}

      {error && (
        <div className="banner banner-error">
          <AlertTriangle size={16} />
          {error}
        </div>
      )}

      <button className="btn btn-ghost" onClick={() => void handlePick()}>
        <FolderSearch size={15} />
        手动选择安装目录
      </button>

      <div className="step-actions">
        <div className="step-actions-left">
          <button className="btn btn-text" onClick={onBack}>
            上一步
          </button>
          <button className="btn btn-text" onClick={onNext}>
            暂时跳过
          </button>
        </div>
        <button className="btn btn-primary" onClick={onNext} disabled={phase !== "found"}>
          下一步
        </button>
      </div>
    </div>
  );
}
