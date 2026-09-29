"""运行环境：先找能复用的，找不到才新建。

**为什么不是上来就 `pip install`**：新用户的机器上很可能已经有现成的环境——

* 他之前已经装过一份 COMSOLPilot（`.venv` 里 mph / mcp 都在），MCP 客户端配置里
  还留着那个解释器路径；
* 或者他本来就有 conda 环境 / 系统 Python，而依赖已经齐了。

这种情况下再建一个 venv 下 150MB 依赖，纯属浪费——用户等几分钟，磁盘上多一份
重复环境，还可能因为版本不一致引出新的怪问题。所以流程是：

    发现（discover） → 有能用的就直接复用 → 一个都没有才新建 venv + 安装

探测用 `importlib.util.find_spec` 而不是真的 `import`：jpype 会去碰 JVM，
只判断「包在不在」不该付出那个代价。
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Callable, Iterator, Optional

try:
    import paths
except ImportError:  # pragma: no cover
    from . import paths  # type: ignore[no-redef]

# 与 start_comsol_server.bat 同序：numpy 的 wheel 在 3.13 上另有分支，
# 3.10~3.12 最稳，所以优先挑它们。
PREFERRED_VERSIONS = ("3.12", "3.11", "3.10", "3.13")

REQUIRED_PACKAGES = ("mcp", "mph", "jpype", "pydantic")

PROBE_TIMEOUT = 25
DISCOVERY_TTL = 60.0

# 探测脚本：只回报版本与「包在不在」，不导入任何重物
_PROBE_SOURCE = (
    "import json,sys,importlib.util as u;"
    "print(json.dumps({"
    "'version':'.'.join(str(p) for p in sys.version_info[:3]),"
    "'packages':{m: u.find_spec(m) is not None for m in %r}}))"
    % (list(REQUIRED_PACKAGES),)
)

SOURCE_LABELS = {
    "settings": "上次选定的环境",
    "env-var": "COMSOLPILOT_PYTHON 指定",
    "core-venv": "本应用的环境",
    "mcp-config": "已注册的 COMSOLPilot",
    "existing-install": "本机已装的 COMSOLPilot",
    "conda": "Conda 环境",
    "path": "系统 Python",
}

_cache: dict = {"at": 0.0, "items": []}
_cache_lock = threading.Lock()


@dataclass
class Environment:
    path: str
    version: str = ""
    source: str = ""
    label: str = ""
    packages: dict = field(default_factory=dict)
    usable: bool = False
    project_root: Optional[str] = None

    def to_dict(self) -> dict:
        data = asdict(self)
        data["source_label"] = SOURCE_LABELS.get(self.source, self.source)
        return data


# ---------------------------------------------------------------------------
# 核心落地（打包态）
# ---------------------------------------------------------------------------

def ensure_core_installed() -> tuple[bool, str]:
    """打包态下把随包的核心复制到持久目录。开发态是空操作。"""
    if not paths.is_frozen():
        return True, str(paths.core_root())

    target = paths.persistent_core()
    if (target / "src" / "server.py").is_file():
        return True, str(target)

    source = paths.bundled_core()
    if not (source / "src" / "server.py").is_file():
        return False, f"随包核心不完整，缺少 {source / 'src' / 'server.py'}"
    try:
        shutil.copytree(
            source,
            target,
            dirs_exist_ok=True,
            ignore=shutil.ignore_patterns(
                ".venv", "__pycache__", "*.pyc", "logs", "target"
            ),
        )
    except OSError as exc:
        return False, f"复制核心到 {target} 失败：{exc}"
    return True, str(target)


# ---------------------------------------------------------------------------
# 探测
# ---------------------------------------------------------------------------

def probe(path: Path) -> Optional[Environment]:
    """跑一次目标解释器，回报版本与依赖是否齐备。"""
    if not path.is_file():
        return None
    try:
        done = subprocess.run(
            [str(path), "-c", _PROBE_SOURCE],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=PROBE_TIMEOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except (OSError, subprocess.SubprocessError):
        return None

    lines = [line for line in (done.stdout or "").splitlines() if line.strip()]
    if not lines:
        return None
    try:
        payload = json.loads(lines[-1])
    except json.JSONDecodeError:
        return None

    packages = {
        name: bool(payload.get("packages", {}).get(name))
        for name in REQUIRED_PACKAGES
    }
    return Environment(
        path=str(path),
        version=str(payload.get("version") or ""),
        packages=packages,
        usable=all(packages.values()),
    )


# ---------------------------------------------------------------------------
# 候选来源
# ---------------------------------------------------------------------------

def _home() -> Path:
    return Path.home()


def _appdata() -> Path:
    return Path(os.environ.get("APPDATA") or _home() / "AppData" / "Roaming")


def _python_in(root: Path) -> Optional[Path]:
    """`<root>/.venv/Scripts/python.exe`（Windows）或 `<root>/.venv/bin/python`。"""
    for relative in (Path("Scripts") / "python.exe", Path("bin") / "python"):
        candidate = root / ".venv" / relative
        if candidate.is_file():
            return candidate
    return None


def _iter_mcp_configs() -> Iterator[Path]:
    yield _home() / ".workbuddy" / "mcp.json"
    yield _home() / ".claude.json"
    yield _appdata() / "Claude" / "claude_desktop_config.json"
    yield _home() / ".gemini" / "settings.json"
    yield _home() / ".cursor" / "mcp.json"
    yield _home() / ".codeium" / "windsurf" / "mcp_config.json"
    yield _home() / ".config" / "opencode" / "opencode.json"
    yield _home() / ".deepseek" / "mcp.json"
    yield _home() / ".codex" / "config.toml"


def _find_in_mcp_configs() -> list[tuple[Path, Optional[Path]]]:
    """从 MCP 客户端配置里挖出用户**正在用**的 COMSOLPilot 解释器。

    这是最可靠的一条线索：客户端里注册的 `command` 就是实际能跑起来的
    python.exe，`env.PYTHONPATH` 则是项目根。用户装过一次，这里就有记录。
    """
    found: list[tuple[Path, Optional[Path]]] = []
    for config in _iter_mcp_configs():
        if not config.is_file():
            continue
        try:
            text = config.read_text(encoding="utf-8-sig", errors="replace")
        except OSError:
            continue

        # TOML（codex）用正则取 [mcp_servers.comsolpilot] 段里的 command
        if config.suffix == ".toml":
            match = re.search(
                r"\[mcp_servers\.comsolpilot\]\s*(.*?)(?=\n\[|\Z)", text, re.DOTALL
            )
            if match:
                command = re.search(r"command\s*=\s*['\"](.+?)['\"]", match.group(1))
                if command:
                    found.append((Path(command.group(1)), None))
            continue

        try:
            data = json.loads(text)
        except (json.JSONDecodeError, ValueError):
            continue

        section = data.get("mcpServers") or data.get("mcp") or {}
        if not isinstance(section, dict):
            continue
        for name, spec in section.items():
            if not isinstance(spec, dict):
                continue
            haystack = f"{name} {spec.get('command', '')}"
            if "comsol" not in haystack.lower():
                continue

            command = spec.get("command")
            if isinstance(command, list):
                command = command[0] if command else ""
            env = spec.get("env") or spec.get("environment") or {}
            root = env.get("PYTHONPATH") if isinstance(env, dict) else None
            if command:
                found.append(
                    (Path(str(command)), Path(str(root)) if root else None)
                )
    return found


def _convention_roots() -> list[Path]:
    """约定俗成的安装位置（和 start_comsol_server.ps1 里的候选同一套思路）。"""
    roots: list[Path] = []
    for drive in ("C:", "D:", "E:", "F:"):
        base = Path(f"{drive}/")
        if not base.exists():
            continue
        for sub in (
            "software/MCP/COMSOLPilot",
            "MCP/COMSOLPilot",
            "tools/COMSOLPilot",
            "Projects/COMSOLPilot",
            "projects/COMSOLPilot",
            "COMSOLPilot",
        ):
            roots.append(base / sub)
    roots.append(_home() / "COMSOLPilot")
    roots.append(_home() / "Desktop" / "COMSOLPilot")
    return roots


def _conda_roots() -> list[Path]:
    """conda 环境目录：先找 `envs/comsolpilot`，再退而求其次看所有环境。"""
    envs: list[Path] = []
    bases = [
        Path("D:/anaconda"),
        Path("C:/anaconda"),
        _home() / "anaconda3",
        _home() / "miniconda3",
        _home() / "Anaconda3",
        Path("D:/tool/conda"),
        Path("C:/tool/conda"),
    ]
    for base in bases:
        directory = base / "envs"
        if not directory.is_dir():
            continue
        # comsolpilot 专用环境最可能，放最前
        preferred = directory / "comsolpilot"
        if preferred.is_dir():
            envs.append(preferred)
        try:
            for child in sorted(directory.iterdir()):
                if child.is_dir() and child != preferred:
                    envs.append(child)
        except OSError:
            continue
    return envs


def _candidates() -> list[tuple[Path, str, Optional[Path]]]:
    """(解释器, 来源, 项目根) 列表，已按可信度排序并去重。"""
    raw: list[tuple[Path, str, Optional[Path]]] = []

    # 1. 用户上次选定的
    chosen = str(paths.read_json(paths.settings_path()).get("python_exe") or "").strip()
    if chosen:
        raw.append((Path(chosen), "settings", None))

    # 2. 环境变量
    override = os.environ.get("COMSOLPILOT_PYTHON")
    if override:
        raw.append((Path(override), "env-var", None))

    # 3. 本应用自己的环境
    own = paths.core_venv_python()
    if own:
        raw.append((own, "core-venv", paths.core_root()))

    # 4. MCP 客户端配置里已注册的那一份
    for interpreter, root in _find_in_mcp_configs():
        raw.append((interpreter, "mcp-config", root))

    # 5. 约定路径下已装的 COMSOLPilot
    for root in _convention_roots():
        interpreter = _python_in(root)
        if interpreter:
            raw.append((interpreter, "existing-install", root))

    # 6. conda 环境
    for env in _conda_roots():
        for relative in (Path("python.exe"), Path("Scripts") / "python.exe", Path("bin") / "python"):
            candidate = env / relative
            if candidate.is_file():
                raw.append((candidate, "conda", env))
                break

    # 7. PATH 上的 python
    for name in ("python", "python3"):
        located = shutil.which(name)
        if located:
            raw.append((Path(located), "path", None))

    # 去重（按规范化路径），保持顺序
    seen: set[str] = set()
    unique: list[tuple[Path, str, Optional[Path]]] = []
    for interpreter, source, root in raw:
        try:
            key = str(interpreter.resolve()).lower()
        except OSError:
            key = str(interpreter).lower()
        if key in seen:
            continue
        seen.add(key)
        unique.append((interpreter, source, root))
    return unique


# ---------------------------------------------------------------------------
# 发现
# ---------------------------------------------------------------------------

def discover(refresh: bool = False) -> list[Environment]:
    """枚举本机可用的 Python 环境，并标出哪些依赖已齐备。"""
    with _cache_lock:
        fresh = time.monotonic() - float(_cache["at"]) < DISCOVERY_TTL
        if fresh and not refresh and _cache["items"]:
            return list(_cache["items"])

    items: list[Environment] = []
    for interpreter, source, root in _candidates():
        environment = probe(interpreter)
        if environment is None:
            continue
        environment.source = source
        environment.project_root = str(root) if root else None
        environment.label = _describe(environment, root)
        items.append(environment)

    # 可复用的排前面，其次按来源可信度
    order = {key: index for index, key in enumerate(SOURCE_LABELS)}
    items.sort(key=lambda item: (not item.usable, order.get(item.source, 99)))

    with _cache_lock:
        _cache["at"] = time.monotonic()
        _cache["items"] = items
    return list(items)


def _describe(environment: Environment, root: Optional[Path]) -> str:
    parts = [SOURCE_LABELS.get(environment.source, environment.source)]
    if root:
        parts.append(str(root))
    return " · ".join(parts)


def reusable(refresh: bool = False) -> list[Environment]:
    return [item for item in discover(refresh) if item.usable]


def active_interpreter(refresh: bool = False) -> Optional[Path]:
    """当前应当使用的解释器：优先用户选定，其次任意一个依赖齐备的环境。"""
    for item in discover(refresh):
        if item.usable:
            return Path(item.path)
    return None


def use(path: str) -> dict:
    """把某个解释器记为项目要用的环境。"""
    environment = probe(Path(path))
    if environment is None:
        return {"ok": False, "error": f"不是可用的 Python 解释器：{path}"}
    if not environment.usable:
        missing = sorted(name for name, ok in environment.packages.items() if not ok)
        return {
            "ok": False,
            "error": f"该环境缺少依赖：{'、'.join(missing)}",
            "environment": environment.to_dict(),
        }

    # 补上来源信息，界面才能显示「这是复用的哪个环境」
    known = next(
        (item for item in discover() if item.path == environment.path), None
    )
    if known is not None:
        environment.source = known.source
        environment.label = known.label
        environment.project_root = known.project_root

    paths.update_settings(python_exe=str(Path(path)))
    with _cache_lock:
        _cache["at"] = 0.0
    return {"ok": True, "environment": environment.to_dict()}


# ---------------------------------------------------------------------------
# 状态
# ---------------------------------------------------------------------------

def _core_venv_site_packages() -> dict:
    site = paths.core_root() / ".venv" / "Lib" / "site-packages"
    return {name: (site / name).is_dir() for name in REQUIRED_PACKAGES}


def status(refresh: bool = False) -> dict:
    core_present = (paths.core_root() / "src" / "server.py").is_file()
    environments = discover(refresh=refresh)
    chosen = str(paths.read_json(paths.settings_path()).get("python_exe") or "").strip()
    current = next((item for item in environments if item.path == chosen), None)
    if current is None:
        current = next((item for item in environments if item.usable), None)

    return {
        "core_root": str(paths.core_root()),
        "core_present": core_present,
        # 兼容旧字段：核心自带 venv 的存在性
        "venv_present": paths.core_venv_python() is not None,
        "interpreter": current.path if current else None,
        "interpreter_source": current.source if current else None,
        "interpreter_version": current.version if current else None,
        "packages": current.packages if current else _core_venv_site_packages(),
        "missing": sorted(
            name for name, ok in (current.packages if current else _core_venv_site_packages()).items()
            if not ok
        ),
        "reusable": [item.to_dict() for item in environments if item.usable],
        "environments": [item.to_dict() for item in environments],
        "ready": bool(core_present and current and current.usable),
    }


# ---------------------------------------------------------------------------
# 解释器选择（新建环境用）
# ---------------------------------------------------------------------------

def _base_interpreters() -> list[list[str]]:
    candidates: list[list[str]] = []
    if shutil.which("py"):
        candidates.extend([["py", f"-{version}"] for version in PREFERRED_VERSIONS])
    for name in ("python3", "python"):
        if shutil.which(name):
            candidates.append([name])
    # 打包态下 sys.executable 是 sidecar 自己，不是解释器，不能用
    if not paths.is_frozen() and sys.executable:
        candidates.append([sys.executable])
    return candidates


def _probe_command(command: list[str]) -> bool:
    try:
        done = subprocess.run(
            [*command, "-c", "import sys;print(sys.version_info[:2])"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return done.returncode == 0


def find_base_python() -> Optional[list[str]]:
    for command in _base_interpreters():
        if _probe_command(command):
            return command
    return None


# ---------------------------------------------------------------------------
# 子进程输出流
# ---------------------------------------------------------------------------

def _popen(command: list[str], cwd: Path) -> subprocess.Popen[str]:
    return subprocess.Popen(
        command,
        cwd=str(cwd),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )


def _stream(process: subprocess.Popen[str]) -> Iterator[str]:
    assert process.stdout is not None
    for line in process.stdout:
        stripped = line.rstrip()
        if stripped:
            yield stripped
    process.wait()


def _ensure_pip(interpreter: Path, root: Path) -> Iterator[str]:
    """有些 Python 建出的 venv 里没有 pip（ensurepip 被裁掉了），补一次。"""
    try:
        done = subprocess.run(
            [str(interpreter), "-m", "pip", "--version"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=60,
        )
    except (OSError, subprocess.SubprocessError):
        done = None
    if done is not None and done.returncode == 0:
        return

    yield "[info] 环境里没有 pip，尝试用 ensurepip 引导…"
    process = _popen([str(interpreter), "-m", "ensurepip", "--upgrade"], root)
    yield from _stream(process)
    if process.returncode != 0:
        yield "[warn] ensurepip 未能完成，如果后续安装失败请手动安装 pip"


# ---------------------------------------------------------------------------
# 安装
# ---------------------------------------------------------------------------

def _install_requirements(interpreter: Path, root: Path, requirements: Path) -> Iterator[str]:
    yield f"[info] installing dependencies into existing environment: {interpreter}"
    yield from _ensure_pip(interpreter, root)
    process = _popen(
        [str(interpreter), "-m", "pip", "install", "--no-cache-dir", "-r", str(requirements)],
        root,
    )
    yield from _stream(process)
    if process.returncode != 0:
        yield f"[error] dependency installation failed (exit {process.returncode})"
        return
    verified = probe(interpreter)
    if verified is None or not verified.usable:
        missing = sorted(name for name, ok in (verified.packages if verified else {}).items() if not ok)
        yield f"[error] dependency verification failed: {', '.join(missing) or 'unavailable environment'}"
        return
    paths.update_settings(python_exe=str(interpreter))
    yield "[done] repaired environment and verified dependencies"


def stream_install(force: bool = False, interpreter: str = "") -> Iterator[str]:
    """逐行产出日志。默认**先复用**；只有找不到能用的环境（或 force）才装。

    最后一行是 `[done] ...` 或 `[error] ...`。
    """
    ok, detail = ensure_core_installed()
    if not ok:
        yield f"[error] {detail}"
        return

    root = paths.core_root()
    yield f"[info] 核心目录：{root}"

    requirements = root / "requirements-windows.txt"
    if not requirements.is_file():
        yield f"[error] requirements file not found: {requirements}"
        return
    selected = probe(Path(interpreter)) if interpreter else None
    if selected is not None and not selected.usable and not force:
        yield from _install_requirements(Path(selected.path), root, requirements)
        return
    if not requirements.is_file():
        yield f"[error] 找不到依赖清单：{requirements}"
        return

    # ---- 先找能复用的 ----
    if interpreter:
        target = probe(Path(interpreter))
        if target and target.usable:
            paths.update_settings(python_exe=target.path)
            yield f"[done] 已使用指定环境：{target.path}（Python {target.version}）"
            return
        yield f"[warn] 指定环境不可用，继续查找其它环境：{interpreter}"

    if not force:
        for environment in reusable(refresh=True):
            paths.update_settings(python_exe=environment.path)
            source = SOURCE_LABELS.get(environment.source, environment.source)
            yield f"[info] 发现可复用的环境（{source}）"
            yield f"[info]   解释器：{environment.path}"
            yield f"[info]   Python {environment.version}，依赖已齐备"
            yield "[done] 直接复用该环境，无需安装"
            return
        yield "[info] 未发现依赖齐备的环境，将新建一个"

    # ---- 新建 ----
    own = paths.core_venv_python()
    if own is None:
        base = find_base_python()
        if base is None:
            yield (
                "[error] 找不到可用的 Python（需要 3.10 或更高）。"
                "请先安装 Python 并勾选 Add python.exe to PATH。"
            )
            return
        yield f"[info] 使用解释器：{' '.join(base)}"
        yield f"[info] 创建虚拟环境：{root / '.venv'}"
        process = _popen([*base, "-m", "venv", str(root / ".venv")], root)
        yield from _stream(process)
        if process.returncode != 0:
            yield f"[error] 创建虚拟环境失败（退出码 {process.returncode}）"
            return
        own = paths.core_venv_python()
        if own is None:
            yield "[error] 虚拟环境创建完成，但仍找不到 python.exe"
            return
    else:
        yield f"[info] 复用已有的本应用环境：{own}"

    yield from _ensure_pip(own, root)

    yield f"[info] 安装依赖：{requirements.name}（首次约 3-5 分钟）"
    process = _popen(
        [
            str(own),
            "-m",
            "pip",
            "install",
            "--no-cache-dir",
            "-r",
            str(requirements),
        ],
        root,
    )
    yield from _stream(process)

    if process.returncode != 0:
        yield (
            f"[error] 依赖安装失败（退出码 {process.returncode}），"
            "请检查网络或代理后重试"
        )
        return

    paths.update_settings(python_exe=str(own))
    yield "[done] 依赖安装完成"


def install(on_line: Optional[Callable[[str], None]] = None, force: bool = False) -> bool:
    """非流式封装：把每行交给回调，返回是否成功。"""
    succeeded = False
    for line in stream_install(force=force):
        if on_line is not None:
            on_line(line)
        if line.startswith("[done]"):
            succeeded = True
    return succeeded
