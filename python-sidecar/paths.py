"""统一的路径解析。

桌面壳会在两种形态下运行，所有路径都必须对两者成立：

1. **开发态**：直接 `python python-sidecar/sidecar_server.py`，核心就在仓库里的
   `comsolpilot-desktop/core/`。
2. **打包态**：sidecar 被 PyInstaller 打成单文件 exe，核心随包释放到临时目录
   （`sys._MEIPASS/core`）。但核心需要写 `workspace/`（settings.json、runtime.json、
   logs），临时目录退出即销毁，所以第一次安装依赖时会把核心复制到
   `%LOCALAPPDATA%/COMSOLPilot/core` 这份**持久、可写**的目录，之后一律用那份。

这样做的另一个原因是：MCP 客户端（Claude / Cursor / Codex …）自己会去启动
`python -m src.server`，它需要一个真实存在的 Python 环境与目录，临时解包目录
满足不了这个条件。
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

APP_NAME = "COMSOLPilot"

# 环境变量覆盖，方便调试与多实例
ENV_CORE = "COMSOLPILOT_CORE"
ENV_RUNTIME = "COMSOLPILOT_RUNTIME"


def is_frozen() -> bool:
    """是否运行在 PyInstaller 打出的可执行文件里。"""
    return bool(getattr(sys, "frozen", False))


def sidecar_dir() -> Path:
    """python-sidecar/ 目录（开发态）或解包目录（打包态）。"""
    return Path(__file__).resolve().parent


def desktop_root() -> Path:
    """桌面工程根目录：package.json、src-tauri、src 所在处。"""
    return sidecar_dir().parent


def _meipass() -> Path | None:
    base = getattr(sys, "_MEIPASS", None)
    return Path(base) if base else None


def bundled_core() -> Path:
    """随包/随仓库提供的核心目录（只读来源）。"""
    if is_frozen():
        base = _meipass()
        if base is not None and (base / "core").is_dir():
            return base / "core"
        # onedir 或非标准布局：退回到可执行文件旁边
        return Path(sys.executable).resolve().parent / "core"
    return desktop_root() / "core"


def persistent_core() -> Path:
    """持久、可写的核心安装目录（打包态首次安装依赖时落地）。"""
    local = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    return Path(local) / APP_NAME / "core"


def core_root() -> Path:
    """当前应当使用的核心目录。"""
    override = os.environ.get(ENV_CORE)
    if override:
        return Path(override).expanduser()
    if is_frozen():
        target = persistent_core()
        if (target / "src" / "server.py").is_file():
            return target
        return bundled_core()
    return desktop_root() / "core"


def workspace_dir() -> Path:
    return core_root() / "workspace"


def settings_path() -> Path:
    return workspace_dir() / "settings.json"


def runtime_path() -> Path:
    return workspace_dir() / "runtime.json"


def logs_dir() -> Path:
    return workspace_dir() / "logs"


def core_venv_python() -> Path | None:
    """核心虚拟环境里的解释器（还没建好时返回 None）。"""
    for relative in (Path("Scripts") / "python.exe", Path("bin") / "python"):
        candidate = core_root() / ".venv" / relative
        if candidate.exists():
            return candidate
    return None


def bundled_runtime_python() -> Path | None:
    """Python shipped in the installer resources, when present."""
    override = os.environ.get(ENV_RUNTIME, "").strip()
    roots = [Path(override)] if override else []
    if is_frozen():
        base = _meipass()
        if base is not None:
            roots.append(base / "runtime")
        roots.append(Path(sys.executable).resolve().parent / "runtime")
    else:
        roots.append(desktop_root() / "build" / "runtime")
    for root in roots:
        candidate = root / ("python.exe" if os.name == "nt" else "bin/python")
        if candidate.is_file():
            return candidate
    return None


def read_json(path: Path) -> dict[str, Any]:
    """读 JSON，容忍 BOM 与损坏内容——损坏时当作空对象。"""
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def update_settings(**values: Any) -> dict[str, Any]:
    """把若干键合并进 core/workspace/settings.json，不覆盖其他键。"""
    data = read_json(settings_path())
    data.update(values)
    write_json(settings_path(), data)
    return data
