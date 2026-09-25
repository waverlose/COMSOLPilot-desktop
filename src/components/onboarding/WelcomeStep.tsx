interface Props {
  onNext: () => void;
}

export function WelcomeStep({ onNext }: Props) {
  return (
    <div className="step-body step-center">
      <div className="welcome-mark">◆</div>
      <h1 className="step-title">让 AI 直接驱动 COMSOL</h1>
      <p className="step-subtitle">
        接下来几步，我们会找到你的 COMSOL 安装、配置好运行环境，
        并接入你正在用的 AI 客户端，全程大约 3-5 分钟。
      </p>
      <button className="btn btn-primary" onClick={onNext}>
        开始设置
      </button>
    </div>
  );
}
