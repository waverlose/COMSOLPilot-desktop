interface Props {
  onFinish: () => void;
}

export function DoneStep({ onFinish }: Props) {
  return (
    <div className="step-body step-center">
      <div className="welcome-mark welcome-mark-done">✓</div>
      <h2 className="step-title-sm">一切就绪</h2>
      <p className="step-subtitle">
        COMSOL 已找到，依赖已装好，AI 客户端已配置完成。
      </p>
      <p className="step-subtitle">
        接下来在「概览」页启动 COMSOL 服务端，然后到 AI 客户端里重新信任一次
        连接器，就可以直接对话驱动 COMSOL 了。
      </p>
      <button className="btn btn-primary" onClick={onFinish}>
        进入 COMSOLPilot
      </button>
    </div>
  );
}
