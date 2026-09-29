// 状态栏。
//
// COMSOL 最底下那条细灰条：一眼能看到「有没有连上、服务端在不在跑、用的是哪个版本」。
// 数据来自全局 store，和页面共用同一份，不额外打接口。
import type { AppSnapshot } from "../lib/appState";

interface Props {
  snapshot: AppSnapshot;
}

export function StatusBar({ snapshot }: Props) {
  const { state, error } = snapshot;

  const server = state?.server;
  const running = server?.running ?? false;
  const starting = server?.starting ?? false;

  const linkLabel = error !== null ? "本地服务连接失败" : state === null ? "正在连接…" : "就绪";
  const linkTone = error !== null ? "is-warn" : state === null ? "is-off" : "is-ok";

  const serverLabel = starting ? "启动中…" : running ? `运行中 :${server?.port ?? "—"}` : "已停止";

  const comsol = state?.comsol;
  const comsolLabel = comsol?.found ? `COMSOL ${comsol.version ?? ""}`.trim() : "COMSOL 未检测";

  const deps = state?.deps;
  const pythonLabel = deps?.ready
    ? `Python ${deps.interpreter_version ?? ""}`.trim()
    : "环境未就绪";

  const registered = state?.clients.filter((client) => client.registered).length ?? 0;

  return (
    <div className="statusbar">
      <span className="statusbar-item">
        <span className={`statusbar-dot ${linkTone}`} />
        {linkLabel}
      </span>
      <span className="statusbar-sep" />
      <span className="statusbar-item">{serverLabel}</span>
      <span className="statusbar-sep" />
      <span className="statusbar-item">{comsolLabel}</span>
      <span className="statusbar-sep" />
      <span className="statusbar-item">{pythonLabel}</span>

      <span className="statusbar-spacer" />

      <span className="statusbar-item">客户端 {registered} 已接入</span>
      {deps?.core_root && (
        <>
          <span className="statusbar-sep" />
          <span className="statusbar-item is-mono" title={deps.core_root}>
            core
          </span>
        </>
      )}
    </div>
  );
}
