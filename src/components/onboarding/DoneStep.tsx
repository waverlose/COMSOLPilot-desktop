interface Props {
  onFinish: () => void;
}

export function DoneStep({ onFinish }: Props) {
  return (
    <div className="step-body step-center">
      <div className="welcome-mark welcome-mark-done">✓</div>
      <h2 className="step-title-sm">准备完成</h2>
      <p className="step-subtitle">
        软件已准备好进入工作台。AI 客户端配置由你复制或交给 AI 添加，COMSOL 服务也由你在主页启动。
      </p>
      <p className="step-subtitle">
        添加配置后，到对应 AI 客户端重新信任或启用 comsolpilot，重启客户端并新建一个对话。旧对话不会自动刷新 MCP 工具列表。
      </p>
      <button className="btn btn-primary" onClick={onFinish}>
        进入工作台
      </button>
    </div>
  );
}
