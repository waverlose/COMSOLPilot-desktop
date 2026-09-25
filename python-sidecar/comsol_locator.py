"""COMSOL 安装探测。

三层探测，顺序即优先级：

1. `core/workspace/settings.json` 里用户明确指定过的可执行文件（手动选择或版本
   切换留下的记录）——用户说了算；
2. `~/.comsolpilot/config.json` 里缓存的手动目录——核心还没装好时也能用；
3. MPh 自己的 discovery——它已经处理了 PATH / 注册表 / 常见安装目录，
   比重新造轮子可靠得多。

第 3 步**故意走子进程**：调用核心虚拟环境里的 python 去跑
`scripts/list_comsol_versions.py`，而不是在 sidecar 进程里 `import mph`。
这样 sidecar 不必依赖 jpype（体积大、和打包工具冲突多），也不必跟 COMSOL 的
JVM 共处一个进程。
"""
from __future__ import annotations

import json
import re
import subprocess
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Optional

try:
    import deps_installer
    import paths
except ImportError:  # pragma: no cover
    from . import deps_installer, paths  # type: ignore[no-redef]

CONFIG_PATH = Path.home() / ".comsolpilot" / "config.json"

VERSION_SCAN_TIMEOUT = 240


@dataclass
class ComsolInfo:
    found: bool
    path: Optional[str] = None
    version: Optional[str] = None
    server_binary: Optional[str] = None
    desktop_binary: Optional[str] = None
    source: Optional[str] = None  # settings | manual | mph


# ---------------------------------------------------------------------------
# 手动指定（用户从原生文件夹选择器挑的目录）
# ---------------------------------------------------------------------------

def _load_manual_override() -> Optional[str]:
    try:
        data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    value = data.get("comsol_path")
    return str(value) if value else None


def _save_manual_override(path: str) -> None:
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    data: dict = {}
    try:
        data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            data = {}
    except (OSError, ValueError):
        data = {}
    data["comsol_path"] = path
    CONFIG_PATH.write_text(
        json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8"
    )


def _dotted_version(folder_name: str) -> Optional[str]:
    """`COMSOL62` → `6.2`；MPh 拿不到版本名时的兜底推导。"""
    digits = re.sub(r"\D", "", folder_name or "")
    if not digits:
        return None
    return ".".join(digits) if len(digits) > 1 else digits


def _install_root(server: Path) -> Path:
    """从 `.../COMSOL62/Multiphysics/bin/win64/comsolmphserver.exe` 取出 `.../COMSOL62`。"""
    for parent in server.parents:
        if parent.name.upper().startswith("COMSOL"):
            return parent
    return server.parent


def _info_from_server(server: Path, source: str) -> ComsolInfo:
    desktop = server.with_name("comsol.exe")
    root = _install_root(server)
    return ComsolInfo(
        found=True,
        path=str(root),
        version=_dotted_version(root.name),
        server_binary=str(server),
        desktop_binary=str(desktop) if desktop.is_file() else None,
        source=source,
    )


def _inspect_manual_path(path: str) -> ComsolInfo:
    """校验用户手选的目录里真的有 COMSOL 服务端可执行文件。"""
    root = Path(path)
    if not root.is_dir():
        return ComsolInfo(found=False)

    candidates = list(root.rglob("comsolmphserver.exe"))
    if not candidates:
        return ComsolInfo(found=False)
    # 同一目录下可能有多个版本，取路径最深的（版本目录内）那个
    return _info_from_server(sorted(candidates, key=lambda p: len(p.parts))[-1], "manual")


# ---------------------------------------------------------------------------
# MPh discovery（子进程）
# ---------------------------------------------------------------------------

def _run_versions_script() -> Optional[dict]:
    script = paths.core_root() / "scripts" / "list_comsol_versions.py"
    if not script.is_file():
        return None

    # 用当前生效的解释器（可能是复用的其它环境，不一定是 core/.venv）
    interpreter = deps_installer.active_interpreter()
    if interpreter is None:
        return None

    try:
        done = subprocess.run(
            [str(interpreter), str(script)],
            cwd=str(paths.core_root()),
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=VERSION_SCAN_TIMEOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except (OSError, subprocess.SubprocessError):
        return None

    # 脚本只打印一行 JSON；保留最后一行非空内容，避免被警告行带偏
    lines = [line for line in (done.stdout or "").splitlines() if line.strip()]
    if not lines:
        return None
    try:
        data = json.loads(lines[-1])
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) and data.get("success") else None


def _info_from_entry(entry: dict, source: str) -> ComsolInfo:
    server = str(entry.get("server") or "")
    desktop = str(entry.get("desktop") or "")
    root = _install_root(Path(server)) if server else None
    name = str(entry.get("name") or "").strip()
    return ComsolInfo(
        found=bool(server),
        path=str(root) if root else None,
        version=name or (_dotted_version(root.name) if root else None),
        server_binary=server or None,
        desktop_binary=desktop or None,
        source=source,
    )


# ---------------------------------------------------------------------------
# 对外接口
# ---------------------------------------------------------------------------

def versions() -> dict:
    """所有可用的 COMSOL 安装，供设置页做版本切换。"""
    data = _run_versions_script()
    if not data:
        return {"available": False, "active": "", "versions": []}
    items = []
    for entry in data.get("versions") or []:
        items.append(
            {
                "name": str(entry.get("name") or ""),
                "server": str(entry.get("server") or ""),
                "desktop": str(entry.get("desktop") or ""),
            }
        )
    return {"available": True, "active": str(data.get("active") or ""), "versions": items}


def set_version(name: str) -> dict:
    """把项目固定到某个 COMSOL 版本（写进 settings.json，启动脚本会读）。"""
    data = _run_versions_script()
    if not data:
        return {"ok": False, "error": "无法枚举 COMSOL 安装（依赖可能尚未安装）"}

    entry = next(
        (v for v in data.get("versions") or [] if str(v.get("name")) == name), None
    )
    if entry is None:
        available = ", ".join(str(v.get("name")) for v in data.get("versions") or [])
        return {"ok": False, "error": f"未找到 COMSOL {name}（可用：{available or '无'}）"}

    paths.update_settings(
        comsol_version=name,
        comsol_server_exe=str(entry.get("server") or ""),
        comsol_desktop_exe=str(entry.get("desktop") or ""),
    )
    return {"ok": True, "version": name}


def quick_info() -> ComsolInfo:
    """不做扫描的廉价探测，供仪表盘轮询使用。"""
    settings = paths.read_json(paths.settings_path())

    server = str(settings.get("comsol_server_exe") or "").strip()
    if server and Path(server).is_file():
        info = _info_from_server(Path(server), "settings")
        # settings 里的 comsol_version 是用户选的，比从目录名猜的准
        version = str(settings.get("comsol_version") or "").strip()
        if version:
            info.version = version
        return info

    runtime = paths.read_json(paths.runtime_path())
    running_server = str(runtime.get("server_exe") or "").strip()
    if running_server and Path(running_server).is_file():
        info = _info_from_server(Path(running_server), "settings")
        version = str(runtime.get("comsol_version") or "").strip()
        if version:
            info.version = version
        return info

    return ComsolInfo(found=False)


def detect() -> ComsolInfo:
    """完整探测（可能耗时十几秒，只在向导/手动刷新时调用）。"""
    quick = quick_info()
    if quick.found:
        return quick

    manual = _load_manual_override()
    if manual:
        info = _inspect_manual_path(manual)
        if info.found:
            return info

    data = _run_versions_script()
    if data:
        entries = list(data.get("versions") or [])
        if entries:
            active = str(data.get("active") or "")
            chosen = next(
                (e for e in entries if str(e.get("name")) == active), entries[-1]
            )
            info = _info_from_entry(chosen, "mph")
            if info.found:
                return info

    return ComsolInfo(found=False)


def set_manual_path(path: str) -> ComsolInfo:
    """用户手动选定安装目录：校验 → 缓存 → 写进核心 settings。"""
    info = _inspect_manual_path(path)
    if not info.found:
        return info

    _save_manual_override(path)
    # 让核心的启动脚本直接用这个可执行文件，而不是再去猜版本
    paths.update_settings(
        comsol_server_exe=info.server_binary or "",
        comsol_desktop_exe=info.desktop_binary or "",
        comsol_version=info.version or "",
    )
    return info


def to_dict(info: ComsolInfo) -> dict:
    return asdict(info)
