"""把 `core/` 接入 sidecar 进程。

sidecar 只负责「系统能力 + HTTP 接口」，真正的 COMSOL 逻辑全部在 `core/src` 下。
这个模块做两件事，顺序不能颠倒：

1. 修好 Windows 环境变量。`mph` 在 **import 时**就读 `%APPDATA%`，而某些 shell
   （Git Bash、部分 CI）根本不传这些变量，于是还没跑到我们的代码就
   `KeyError: 'APPDATA'` 了。
2. 把核心目录插进 `sys.path`，之后 `import src.mcp_targets` 才能成立。

核心是 `src/` 这个顶层包，和前端那份 React 的 `src/` 没有关系——它们在不同
的目录树下，不会互相遮蔽。
"""
from __future__ import annotations

import importlib
import os
import platform
import sys
from pathlib import Path
from types import ModuleType

try:  # 直接以脚本运行（sys.path[0] = python-sidecar/）
    import paths
except ImportError:  # 被当作包导入时
    from . import paths  # type: ignore[no-redef]


def ensure_windows_env() -> None:
    """补全 `mph` / COMSOL 需要的 Windows 环境变量。"""
    if platform.system() != "Windows":
        return

    home = Path.home()
    defaults = {
        "USERPROFILE": str(home),
        "APPDATA": str(home / "AppData" / "Roaming"),
        "LOCALAPPDATA": str(home / "AppData" / "Local"),
    }
    for key, value in defaults.items():
        current = os.environ.get(key)
        # 某些工具会把 Windows 路径写成带正斜杠的形式，MPh 会拼出错误路径
        if not current or "/" in current:
            os.environ[key] = value
    os.environ.setdefault("USERNAME", os.environ.get("USERNAME") or home.name)
    # stdio / 文件一律 UTF-8，否则中文输出在 GBK 代码页下会乱码
    os.environ.setdefault("PYTHONUTF8", "1")
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")


def ensure_core_on_path() -> str:
    """把核心目录放到 `sys.path` 最前面，返回该目录。"""
    root = str(paths.core_root())
    if root in sys.path:
        sys.path.remove(root)
    sys.path.insert(0, root)
    return root


def core_ready() -> bool:
    return (paths.core_root() / "src" / "server.py").is_file()


def load_core_module(name: str) -> ModuleType:
    """导入核心里的模块（例如 `src.mcp_targets`）。

    每次都重新解析路径，方便开发时热改核心代码而不必重启 sidecar。
    """
    ensure_windows_env()
    ensure_core_on_path()
    return importlib.import_module(name)


def try_load_core_module(name: str) -> ModuleType | None:
    """导入失败时返回 None，让上层给出友好提示而不是 500。"""
    try:
        return load_core_module(name)
    except Exception:  # noqa: BLE001 - 核心未安装/依赖缺失都走这条路
        return None
