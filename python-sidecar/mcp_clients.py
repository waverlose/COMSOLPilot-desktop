"""MCP 客户端注册。

这里不再有「假数据」——全部转调核心 `src/mcp_targets.py` 的真实实现：

* 「是否装了某个客户端」用 `detected_clients()`（配置文件或配置目录存在）；
* 「是否已经注册」用 `sync_client(..., dry_run=True)` 的 `action == "ok"` 判断，
  它会把 COMSOL_PORT 与新版环境变量（PYTHONPATH / UTF-8 / Windows 变量）一起
  比对，所以老版本写下的不完整条目也会被识别成「需要更新」；
* 「注册」用 `sync_client(..., ensure=True)`，它会先备份原文件再写入，且只动
  comsolpilot 那一个条目，其他键原样保留。

**默认不创建任何条目**是核心项目刻意的设计（开发者优先）：只有用户在向导里
明确勾选过的客户端才会被写入。
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Iterable, Optional

try:
    import core_bridge
    import deps_installer
    import paths
    import server_manager
except ImportError:  # pragma: no cover
    from . import core_bridge, deps_installer, paths, server_manager  # type: ignore[no-redef]

# 核心没装好时前端仍要能渲染出客户端列表，这里只是兜底展示用的
FALLBACK_CLIENTS: list[tuple[str, str]] = [
    ("workbuddy", "WorkBuddy"),
    ("claude-code", "Claude Code"),
    ("claude-desktop", "Claude Desktop"),
    ("gemini", "Gemini CLI"),
    ("cursor", "Cursor"),
    ("windsurf", "Windsurf"),
    ("opencode", "OpenCode"),
    ("codex", "Codex"),
    ("deepseek", "DeepSeek"),
]


@dataclass
class ClientState:
    id: str
    label: str
    detected: bool
    registered: bool
    path: Optional[str] = None
    detail: Optional[str] = None

    def to_dict(self) -> dict:
        return asdict(self)


def _targets():
    module = core_bridge.try_load_core_module("src.mcp_targets")
    return module


def _fallback(reason: str) -> list[ClientState]:
    return [
        ClientState(id=cid, label=label, detected=False, registered=False, detail=reason)
        for cid, label in FALLBACK_CLIENTS
    ]


def list_clients() -> list[ClientState]:
    """列出所有受支持的客户端及其当前状态。"""
    module = _targets()
    if module is None:
        return _fallback("核心未就绪：请先在「环境依赖」里完成安装")

    port = server_manager.resolved_port()
    try:
        detected = set(module.detected_clients())
        keys = list(module.TARGET_KEYS)
    except Exception as exc:  # noqa: BLE001
        return _fallback(f"读取核心客户端注册表失败：{exc}")

    states: list[ClientState] = []
    for key in keys:
        try:
            item = module.sync_client(key, port, ensure=False, dry_run=True)
        except Exception as exc:  # noqa: BLE001
            states.append(
                ClientState(id=key, label=key, detected=False, registered=False,
                            detail=f"检查失败：{exc}")
            )
            continue
        states.append(
            ClientState(
                id=key,
                label=str(item.get("label") or key),
                detected=key in detected,
                registered=item.get("action") == "ok",
                path=item.get("path"),
                detail=item.get("detail") or item.get("reason"),
            )
        )
    return states


def config_profile(client_id: str) -> dict:
    """Return a copy-ready connector profile without modifying client files."""
    dependency_status = deps_installer.status(refresh=True)
    if not dependency_status.get("ready"):
        missing = ", ".join(dependency_status.get("missing") or [])
        detail = f"Python 环境未就绪，请先安装依赖{(': ' + missing) if missing else ''}"
        raise RuntimeError(detail)
    module = _targets()
    if module is None:
        raise RuntimeError("核心环境未就绪，请先完成开始引导中的运行环境步骤")

    target = next((item for item in module._targets() if item.key == client_id), None)
    if target is None:
        raise ValueError(f"不支持的 AI 客户端：{client_id}")

    config_path = target.resolve() or target.candidates[0]
    port = server_manager.resolved_port()
    entry = module._entry_for_kind(target.kind, port)
    settings = paths.read_json(paths.settings_path())
    interpreter = str(settings.get("python_exe") or module.python_exe())
    if target.kind == "opencode":
        entry["command"] = [interpreter, *entry.get("command", [])[1:]]
    else:
        entry["command"] = interpreter

    return {
        "id": target.key,
        "label": target.label,
        "kind": target.kind,
        "path": str(config_path),
        "core_root": str(module.project_root()),
        "python_exe": interpreter,
        "port": port,
        "entry": entry,
    }


def register(client_ids: Iterable[str]) -> tuple[list[ClientState], list[dict]]:
    """为选中的客户端创建/更新条目，返回 (最新状态, 逐项结果)。"""
    dependency_status = deps_installer.status(refresh=True)
    if not dependency_status.get("ready"):
        missing = ", ".join(dependency_status.get("missing") or [])
        reason = f"Python environment is not ready; install dependencies first{(': ' + missing) if missing else ''}"
        return [], [{"client": key, "action": "failed", "reason": reason} for key in client_ids]
    module = _targets()
    if module is None:
        return _fallback("核心未就绪"), []

    port = server_manager.resolved_port()
    results: list[dict] = []
    for key in client_ids:
        try:
            results.append(module.sync_client(key, port, ensure=True))
        except Exception as exc:  # noqa: BLE001
            results.append({"client": key, "action": "failed", "reason": str(exc)})
    return list_clients(), results


def sync_registered() -> tuple[list[ClientState], list[dict]]:
    """只同步「已经注册过」的客户端，不创建新条目（换端口后用）。"""
    module = _targets()
    if module is None:
        return _fallback("核心未就绪"), []

    port = server_manager.resolved_port()
    results: list[dict] = []
    for state in list_clients():
        if not state.registered:
            continue
        try:
            results.append(module.sync_client(state.id, port, ensure=False))
        except Exception as exc:  # noqa: BLE001
            results.append({"client": state.id, "action": "failed", "reason": str(exc)})
    return list_clients(), results
