import appIcon from "../../../src-tauri/icons/icon.png";

interface Props {
  onNext: () => void;
  onSkip: () => void;
}

export function WelcomeStep({ onNext, onSkip }: Props) {
  return (
    <div className="step-body step-center">
      <div className="welcome-mark">
        <img src={appIcon} alt="" draggable={false} />
      </div>
      <h1 className="step-title">让 AI 直接驱动 COMSOL</h1>
      <p className="step-subtitle">
        按顺序确认 COMSOL 与运行环境，启动可观察的服务，再连接你选择的 AI 客户端。
      </p>
      <div className="welcome-actions">
        <button className="btn btn-primary" onClick={onNext}>开始设置</button>
        <button className="btn btn-text" onClick={onSkip}>稍后再说</button>
      </div>
    </div>
  );
}
