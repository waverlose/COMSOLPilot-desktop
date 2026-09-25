"""COMSOL 服务端生命周期管理。

不重新实现启动逻辑，而是直接复用核心 `scripts/start_comsol_server.ps1`：那里已经
处理了一堆踩过坑的细节——端口被临时 socket 占用时自动顺延、从 COMSOL 自己的日志
里读出真实端口、JVM 启动最长等 90 秒、把结果写进 `workspace/runtime.json`。桌面壳
要做的是「触发 + 把输出喂给前端 + 读回状态」，不是把它抄一遍。

启动是**异步**的：真实启动要 30-60 秒，HTTP 请求不能一直挂着，所以 `start()` 立刻
返回 `starting: true`，前端轮询 `/api/server/status` 直到 `running` 变真。
"""
from __future__ import annotations

import os
import shutil
import socket
import subprocess
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Callable, Optional

try:
    import paths
except ImportError:  # pragma: no cover
    from . import paths  # type: ignore[no-redef]

DEFAULT_PORT = 2036
LOG_BUFFER = 400
VALID_LOGIN_MODES = ("auto", "never", "info", "force")

_lock = threading.Lock()
_starting = False
_last_error: Optional[str] = None
_log: list[str] = []


# ---------------------------------------------------------------------------
# 小工具
# ---------------------------------------------------------------------------

def _append_log(line: str) -> None:
    with _lock:
        _log.append(line)
        if len(_log) > LOG_BUFFER:
            del _log[: len(_log) - LOG_BUFFER]
    # 打到 stdout，Rust 侧会转发成 sidecar-log 事件，日志页能看到
    print(line, flush=True)


def _powershell() -> str:
    return shutil.which("powershell") or shutil.which("pwsh") or "powershell"


def _ps_quote(value: object) -> str:
    """PowerShell 单引号字面量：内部单引号翻倍即可，反斜杠无需转义。"""
    return "'" + str(value).replace("'", "''") + "'"


def _ps_command(script: Path, args: list[str]) -> list[str]:
    # 让 PowerShell 以 UTF-8 输出：默认它按控制台代码页（中文机器上是 GBK）写
    # stdout，管道里读出来就是乱码。没有控制台时设置会抛异常，所以包一层 try。
    prologue = (
        "try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}; "
        "try { $OutputEncoding = [Console]::OutputEncoding } catch {}; "
    )
    invocation = "& " + _ps_quote(script) + "".join(" " + _ps_quote(a) for a in args)
    return [
        _powershell(),
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        prologue + invocation,
    ]


def _run_ps(script: Path, args: list[str], on_line: Callable[[str], None]) -> int:
    env = os.environ.copy()
    env.setdefault("PYTHONUTF8", "1")
    creationflags = 0
    if os.name == "nt":
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)

    process = subprocess.Popen(
        _ps_command(script, args),
        cwd=str(paths.core_root()),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
        env=env,
        creationflags=creationflags,
    )
    assert process.stdout is not None
    for line in process.stdout:
        stripped = line.rstrip()
        if stripped:
            on_line(stripped)
    process.wait()
    return process.returncode


def _script(name: str) -> Path:
    return paths.core_root() / "scripts" / name


# ---------------------------------------------------------------------------
# 端口
# ---------------------------------------------------------------------------

def resolved_port() -> int:
    """端口优先级：runtime.json（在跑的服务端）→ settings.json → 环境变量 → 2036。"""
    for path in (paths.runtime_path(), paths.settings_path()):
        value = paths.read_json(path).get("port")
        if isinstance(value, int) and 0 < value < 65536:
            return value
    try:
        return int(os.environ.get("COMSOL_PORT") or DEFAULT_PORT)
    except ValueError:
        return DEFAULT_PORT


def port_listening(port: int, host: str = "localhost", timeout: float = 1.0) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


# ---------------------------------------------------------------------------
# 状态
# ---------------------------------------------------------------------------

def _uptime_seconds(started_at: object) -> Optional[float]:
    if not isinstance(started_at, str) or not started_at:
        return None
    try:
        started = datetime.fromisoformat(started_at)
    except ValueError:
        return None
    delta = (datetime.now() - started).total_seconds()
    return delta if delta >= 0 else None


def _status_locked() -> dict:
    runtime = paths.read_json(paths.runtime_path())
    runtime_port = runtime.get("port")
    port = runtime_port if isinstance(runtime_port, int) else resolved_port()
    running = port_listening(port)

    return {
        "running": running,
        "starting": _starting,
        "port": port,
        "configured_port": resolved_port(),
        "pid": runtime.get("pid"),
        "mode": runtime.get("mode"),
        "server_exe": runtime.get("server_exe"),
        "comsol_version": runtime.get("comsol_version"),
        "started_at": runtime.get("started_at"),
        "uptime_seconds": _uptime_seconds(runtime.get("started_at")) if running else None,
        "error": _last_error,
        "log_tail": _log[-40:],
    }


def status() -> dict:
    with _lock:
        return _status_locked()


# ---------------------------------------------------------------------------
# 启动 / 停止
# ---------------------------------------------------------------------------

def _start_arguments(mode: str) -> list[str]:
    settings = paths.read_json(paths.settings_path())
    args = ["-Port", str(resolved_port())]

    login_mode = str(settings.get("login_mode") or "").strip()
    if login_mode in VALID_LOGIN_MODES:
        args += ["-LoginMode", login_mode]

    version = str(settings.get("comsol_version") or "").strip()
    if version:
        args += ["-Version", version]

    # 手动指定的可执行文件优先于版本探测，否则用户手选的路径会被忽略
    server_exe = str(settings.get("comsol_server_exe") or "").strip()
    if server_exe and Path(server_exe).is_file():
        args += ["-ServerExe", server_exe]

    # 启动脚本要用 python 枚举 COMSOL 版本；把当前生效的解释器（可能是复用的
    # 其它环境）显式传过去，否则它会只认 core/.venv 而找不到 mph。
    python_exe = str(settings.get("python_exe") or "").strip()
    if python_exe and Path(python_exe).is_file():
        args += ["-PythonExe", python_exe]

    cores = settings.get("cores")
    if isinstance(cores, int) and cores > 0:
        args += ["-Cores", str(cores)]

    if mode == "gui":
        args.append("-OpenDesktop")
    return args


def _start_worker(mode: str) -> None:
    global _starting, _last_error
    script = _script("start_comsol_server.ps1")
    if not script.is_file():
        with _lock:
            _starting = False
            _last_error = f"找不到启动脚本：{script}"
        _append_log(f"[error] {_last_error}")
        return

    args = _start_arguments(mode)
    _append_log(f"[info] 启动 COMSOL 服务端（{mode}）：{' '.join(args)}")
    code = -1
    try:
        code = _run_ps(script, args, _append_log)
    except Exception as exc:  # noqa: BLE001
        _append_log(f"[error] 调用启动脚本失败：{exc}")

    with _lock:
        _starting = False
        if code != 0:
            _last_error = f"COMSOL 服务端启动失败（退出码 {code}），详见日志"
            _append_log(f"[error] {_last_error}")
        else:
            _last_error = None
            _append_log("[done] COMSOL 服务端已就绪")


def start(mode: str = "headless") -> dict:
    """触发启动并立即返回；真正是否起来由前端轮询 status 判断。"""
    global _starting, _last_error

    if mode not in ("headless", "gui"):
        mode = "headless"

    with _lock:
        current = _status_locked()
        if current["running"]:
            return current
        if _starting:
            return current
        _starting = True
        _last_error = None

    threading.Thread(target=_start_worker, args=(mode,), daemon=True).start()
    with _lock:
        return _status_locked()


def stop() -> dict:
    """停掉所有 COMSOL Server 进程（核心脚本按进程名匹配，见 stop_comsol_server.ps1）。"""
    script = _script("stop_comsol_server.ps1")
    if not script.is_file():
        _append_log(f"[error] 找不到停止脚本：{script}")
        return status()

    _append_log("[info] 正在停止 COMSOL 服务端…")
    try:
        _run_ps(script, ["-All"], _append_log)
    except Exception as exc:  # noqa: BLE001
        _append_log(f"[error] 停止失败：{exc}")

    # runtime.json 已经过期，清掉端口/pid 以免状态页显示一个不存在的服务
    runtime = paths.read_json(paths.runtime_path())
    if runtime:
        runtime["pid"] = 0
        paths.write_json(paths.runtime_path(), runtime)

    time.sleep(0.3)
    return status()


def restart(mode: str = "headless") -> dict:
    stop()
    return start(mode)


# ---------------------------------------------------------------------------
# 日志文件
# ---------------------------------------------------------------------------

def tail_logs(lines: int = 200) -> dict:
    """读取最新一份 COMSOL 服务端日志的尾部（前端「日志」页用）。"""
    directory = paths.logs_dir()
    if not directory.is_dir():
        return {"file": None, "lines": []}
    files = sorted(
        (p for p in directory.glob("*.log") if p.is_file()),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    if not files:
        return {"file": None, "lines": []}
    newest = files[0]
    try:
        content = newest.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError as exc:
        return {"file": str(newest), "lines": [f"[error] 读取日志失败：{exc}"]}
    return {"file": str(newest), "lines": content[-max(1, lines):]}
