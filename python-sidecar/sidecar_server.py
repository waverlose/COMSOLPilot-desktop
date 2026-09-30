"""COMSOLPilot 桌面壳的本地后端（FastAPI）。

由 Tauri 以 sidecar 形式拉起，只监听 127.0.0.1 上一个由 Rust 侧挑选的空闲端口，
给前端提供 REST 接口。业务逻辑全在同目录模块里，它们再转调 `core/` 的真实实现。

安全模型（本地服务，但仍不能裸奔）：

* 只绑回环地址，不对外网暴露；
* CORS 只放行本机开发端口与 Tauri webview 的来源，别的网站读不到响应；
* Rust 侧每次启动生成一个随机 token，通过 `--token` 传入；所有 `/api/*` 请求
  都要带 `X-COMSOLPILOT-TOKEN`。手动运行（不带 `--token`）时自动关闭校验，
  方便本地调试。

用法：
    python sidecar_server.py --port 8765 [--token <hex>] [--core <dir>]
"""
from __future__ import annotations

import argparse
import os
import json
import subprocess
import sys
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

# 允许以脚本方式运行（sys.path[0] = python-sidecar/）
sys.path.insert(0, str(Path(__file__).resolve().parent))

import comsol_locator  # noqa: E402
import core_bridge  # noqa: E402
import deps_installer  # noqa: E402
import mcp_clients  # noqa: E402
import paths  # noqa: E402
import server_manager  # noqa: E402

TOKEN: Optional[str] = None
_uvicorn_server = None
_core_info_cache: Optional[dict] = None

# 开发态是 vite（localhost:5173）；打包态是 Tauri 的 webview 或 Electron 的自定义协议。
#
# Electron 那边刻意没用 file:// —— 它的 Origin 是 null，而且 module script 会被拦。
# 走 app://localhost 就有正常 origin，这里放行即可。
ALLOWED_ORIGIN_REGEX = (
    r"^(https?://(localhost|127\.0\.0\.1)(:\d+)?"
    r"|tauri://localhost"
    r"|https?://tauri\.localhost"
    r"|app://localhost)$"
)

app = FastAPI(title="COMSOLPilot Sidecar", version="0.2.9")


@app.middleware("http")
async def enforce_token(request: Request, call_next):
    """带 token 启动时，拒绝没有正确 token 的 /api 请求。

    预检请求（OPTIONS）按 CORS 规范**不带**自定义头，必须放行——否则浏览器
    的每一次跨域调用都会先在预检这步被挡下，接口全废。
    """
    if TOKEN and request.method != "OPTIONS" and request.url.path.startswith("/api/"):
        if request.headers.get("x-comsolpilot-token") != TOKEN:
            return JSONResponse({"detail": "invalid token"}, status_code=401)
    return await call_next(request)


# 顺序有讲究：Starlette 里**最后添加的中间件在最外层**。CORS 必须在最外层，
# 这样连 401 响应也会带上 CORS 头，前端才能读到错误内容而不是一个笼统的网络错误。
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=ALLOWED_ORIGIN_REGEX,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# 请求体
# ---------------------------------------------------------------------------

class ManualPathBody(BaseModel):
    path: str


class VersionBody(BaseModel):
    version: str


class RegisterClientsBody(BaseModel):
    clients: list[str]


class StartServerBody(BaseModel):
    mode: str = "headless"


class SettingsBody(BaseModel):
    port: Optional[int] = None
    login_mode: Optional[str] = None
    comsol_version: Optional[str] = None
    comsol_server_exe: Optional[str] = None
    comsol_desktop_exe: Optional[str] = None
    table_label: Optional[str] = None
    cores: Optional[int] = None
    python_exe: Optional[str] = None


class InstallDepsBody(BaseModel):
    # 默认先找能复用的环境；force=True 才强制新建并安装
    force: bool = False
    interpreter: Optional[str] = None


class UseEnvBody(BaseModel):
    path: str


# ---------------------------------------------------------------------------
# 基础
# ---------------------------------------------------------------------------

@app.get("/api/health")
def health():
    return {
        "ok": True,
        "core_root": str(paths.core_root()),
        "core_ready": core_bridge.core_ready(),
        "frozen": paths.is_frozen(),
    }


@app.get("/api/state")
def state():
    """仪表盘用的聚合状态，全部是廉价操作（不做 MPh 扫描）。"""
    return {
        "core_root": str(paths.core_root()),
        "comsol": comsol_locator.to_dict(comsol_locator.quick_info()),
        "deps": deps_installer.status(),
        "server": server_manager.status(),
        "clients": [c.to_dict() for c in mcp_clients.list_clients()],
        "settings": _settings_payload(),
    }


@app.get("/api/diagnostics")
def diagnostics():
    """Return a single, actionable readiness report for the desktop UI."""
    comsol = comsol_locator.quick_info()
    deps = deps_installer.status()
    server = server_manager.status()
    clients = mcp_clients.list_clients()
    registered = sum(1 for client in clients if client.registered)
    checks = [
        {
            "id": "comsol",
            "label": "COMSOL 安装",
            "ok": bool(comsol.found),
            "detail": f"COMSOL {comsol.version}" if comsol.found else "未找到 COMSOL",
            "value": comsol.path or "",
        },
        {
            "id": "python",
            "label": "Python 环境",
            "ok": bool(deps.ready),
            "detail": "依赖已就绪" if deps.ready else (f"缺少依赖: {', '.join(deps.missing)}" if deps.missing else "尚未配置环境"),
            "value": deps.interpreter or "",
        },
        {
            "id": "server",
            "label": "COMSOL Server",
            "ok": bool(server.running),
            "detail": "服务运行中" if server.running else (server.error or "服务未运行"),
            "value": f"端口 {server.port}",
        },
        {
            "id": "clients",
            "label": "AI 客户端",
            "ok": registered > 0,
            "detail": f"已接入 {registered} 个客户端" if registered else "尚未接入客户端",
            "value": str(registered),
        },
    ]
    return {
        "ok": all(item["ok"] for item in checks),
        "checks": checks,
        "core": _core_info(),
    }


def _core_info() -> dict:
    global _core_info_cache
    if _core_info_cache is not None:
        return dict(_core_info_cache)

    root = paths.core_root()
    version = "unknown"
    try:
        init_file = root / "src" / "__init__.py"
        for line in init_file.read_text(encoding="utf-8").splitlines():
            if line.startswith("__version__") and "=" in line:
                version = line.split("=", 1)[1].strip().strip("'\" ")
                break
    except OSError:
        pass

    status = deps_installer.status()
    python_exe = status.get("interpreter") or sys.executable
    probe = (
        "import json\n"
        "from src.server import mcp, register_all_tools\n"
        "register_all_tools()\n"
        "print(json.dumps({'tool_count': len(mcp._tool_manager._tools)}))\n"
    )
    env = os.environ.copy()
    env.update({
        "PYTHONPATH": str(root),
        "COMSOLPILOT_CORE": str(root),
        "PYTHONUTF8": "1",
        "PYTHONIOENCODING": "utf-8",
    })
    tool_count = None
    error = None
    try:
        result = subprocess.run(
            [python_exe, "-c", probe], cwd=str(root), env=env,
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=15, check=False,
        )
        lines = result.stdout.strip().splitlines()
        payload = json.loads(lines[-1]) if lines else {}
        if result.returncode == 0:
            tool_count = int(payload["tool_count"])
        else:
            error = result.stderr.strip()[-600:] or "核心工具注册失败"
    except (OSError, subprocess.TimeoutExpired, ValueError, KeyError) as exc:
        error = str(exc)

    _core_info_cache = {
        "version": version,
        "tool_count": tool_count,
        "error": error,
    }
    return dict(_core_info_cache)


def _settings_payload() -> dict:
    settings = paths.read_json(paths.settings_path())
    return {
        # 这两个是给界面「打开日志目录」直接用的，避免前端自己拼路径
        "core_root": str(paths.core_root()),
        "logs_dir": str(paths.logs_dir()),
        "port": server_manager.resolved_port(),
        "configured_port": settings.get("port"),
        "login_mode": settings.get("login_mode") or "auto",
        "comsol_version": settings.get("comsol_version") or "",
        "comsol_server_exe": settings.get("comsol_server_exe") or "",
        "comsol_desktop_exe": settings.get("comsol_desktop_exe") or "",
        "table_label": settings.get("table_label") or "",
        "cores": settings.get("cores") or 0,
        "python_exe": settings.get("python_exe") or "",
    }


# ---------------------------------------------------------------------------
# COMSOL 探测
# ---------------------------------------------------------------------------

@app.get("/api/comsol/detect")
def detect_comsol():
    return comsol_locator.to_dict(comsol_locator.detect())


@app.post("/api/comsol/path")
def set_comsol_path(body: ManualPathBody):
    info = comsol_locator.set_manual_path(body.path)
    if not info.found:
        raise HTTPException(
            status_code=422,
            detail=f"目录里找不到 comsolmphserver.exe：{body.path}",
        )
    return comsol_locator.to_dict(info)


@app.get("/api/comsol/versions")
def list_comsol_versions():
    return comsol_locator.versions()


@app.post("/api/comsol/version")
def set_comsol_version(body: VersionBody):
    result = comsol_locator.set_version(body.version)
    if not result.get("ok"):
        raise HTTPException(status_code=422, detail=result.get("error", "切换版本失败"))
    return result


# ---------------------------------------------------------------------------
# 依赖安装（流式）
# ---------------------------------------------------------------------------

@app.get("/api/deps/status")
def deps_status(refresh: bool = False):
    return deps_installer.status(refresh=refresh)


@app.get("/api/deps/environments")
def deps_environments(refresh: bool = False):
    """本机可用的 Python 环境，含「依赖是否齐备」——用于决定能否直接复用。"""
    items = deps_installer.discover(refresh=refresh)
    return {
        "environments": [item.to_dict() for item in items],
        "reusable": [item.to_dict() for item in items if item.usable],
    }


@app.post("/api/deps/use")
def deps_use(body: UseEnvBody):
    result = deps_installer.use(body.path)
    if not result.get("ok"):
        raise HTTPException(status_code=422, detail=result.get("error", "该环境不可用"))
    return result


@app.post("/api/deps/install")
def install_deps(body: Optional[InstallDepsBody] = None):
    force = bool(body.force) if body else False
    interpreter = (body.interpreter or "") if body else ""

    def generate():
        for line in deps_installer.stream_install(force=force, interpreter=interpreter):
            yield line + "\n"

    return StreamingResponse(generate(), media_type="text/plain; charset=utf-8")


# ---------------------------------------------------------------------------
# MCP 客户端注册
# ---------------------------------------------------------------------------

@app.get("/api/clients")
def get_clients():
    return [c.to_dict() for c in mcp_clients.list_clients()]


@app.get("/api/clients/{client_id}/config")
def get_client_config(client_id: str):
    try:
        return mcp_clients.config_profile(client_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.post("/api/clients/{client_id}/test")
def test_client(client_id: str):
    """Start the configured MCP entry once and report its advertised tools."""
    try:
        profile = mcp_clients.config_profile(client_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    python_exe = str(profile.get("python_exe") or sys.executable)
    root = str(profile.get("core_root") or paths.core_root())
    port = int(profile.get("port") or server_manager.resolved_port())
    probe = (
        "import json\n"
        "from src.server import mcp, register_all_tools\n"
        "from src.tools.catalog import group_tool_names\n"
        "register_all_tools()\n"
        "names = sorted(mcp._tool_manager._tools.keys())\n"
        "print(json.dumps({'tools': names, 'groups': group_tool_names(names)}, ensure_ascii=False))\n"
    )
    env = os.environ.copy()
    env.update({
        "COMSOL_MODE": "gui",
        "COMSOL_HOST": "localhost",
        "COMSOL_PORT": str(port),
        "COMSOL_PREWARM": "off",
        "PYTHONPATH": root,
        "COMSOLPILOT_CORE": root,
        "PYTHONUTF8": "1",
        "PYTHONIOENCODING": "utf-8",
    })
    try:
        completed = subprocess.run(
            [python_exe, "-c", probe], cwd=root, env=env,
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=15, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"ok": False, "client": client_id, "tools": [], "groups": [], "tool_count": 0, "error": str(exc)}
    output = completed.stdout.strip().splitlines()
    try:
        payload = json.loads(output[-1]) if output else {}
        tools = payload.get("tools", []) if isinstance(payload, dict) else []
        groups = payload.get("groups", []) if isinstance(payload, dict) else []
    except json.JSONDecodeError:
        tools = []
        groups = []
    ok = completed.returncode == 0 and isinstance(tools, list)
    return {
        "ok": ok,
        "client": client_id,
        "tools": tools if ok else [],
        "groups": groups if ok else [],
        "tool_count": len(tools) if ok else 0,
        "error": None if ok else (completed.stderr.strip()[-1200:] or "MCP 进程未能完成初始化"),
    }


@app.post("/api/clients/register")
def register_clients(body: RegisterClientsBody):
    states, results = mcp_clients.register(body.clients)
    failures = [item for item in results if item.get("action") in {"failed", "skipped"} or item.get("written") is False]
    if failures:
        detail = "; ".join(
            f"{item.get('client', 'client')}: {item.get('reason', 'registration failed')}"
            for item in failures
        )
        raise HTTPException(status_code=409, detail=detail)
    return {"clients": [c.to_dict() for c in states], "results": results}


@app.post("/api/clients/sync")
def sync_clients():
    """把已注册客户端的 COMSOL_PORT 同步到当前端口（不新建条目）。"""
    states, results = mcp_clients.sync_registered()
    return {"clients": [c.to_dict() for c in states], "results": results}


# ---------------------------------------------------------------------------
# 服务端生命周期
# ---------------------------------------------------------------------------

@app.get("/api/server/status")
def server_status():
    return server_manager.status()


@app.post("/api/server/start")
def server_start(body: Optional[StartServerBody] = None):
    mode = (body.mode if body else None) or "headless"
    return server_manager.start(mode)


@app.post("/api/server/stop")
def server_stop():
    return server_manager.stop()


@app.post("/api/server/restart")
def server_restart(body: Optional[StartServerBody] = None):
    mode = (body.mode if body else None) or "headless"
    return server_manager.restart(mode)


@app.get("/api/logs/tail")
def logs_tail(lines: int = 200):
    return server_manager.tail_logs(lines)


# ---------------------------------------------------------------------------
# 设置
# ---------------------------------------------------------------------------

@app.get("/api/settings")
def get_settings():
    return _settings_payload()


@app.post("/api/settings")
def update_settings(body: SettingsBody):
    patch: dict = {}

    if body.port is not None:
        if not (1024 <= body.port <= 65535):
            raise HTTPException(status_code=422, detail="端口需在 1024-65535 之间")
        patch["port"] = body.port

    if body.login_mode is not None:
        if body.login_mode not in server_manager.VALID_LOGIN_MODES:
            raise HTTPException(
                status_code=422,
                detail=f"login_mode 只能是 {', '.join(server_manager.VALID_LOGIN_MODES)}",
            )
        patch["login_mode"] = body.login_mode

    if body.cores is not None:
        if body.cores < 0:
            raise HTTPException(status_code=422, detail="cores 不能为负数")
        patch["cores"] = body.cores

    for field in ("comsol_version", "comsol_server_exe", "comsol_desktop_exe",
                  "table_label", "python_exe"):
        value = getattr(body, field)
        if value is not None:
            patch[field] = value

    if patch:
        paths.update_settings(**patch)
    return _settings_payload()


# ---------------------------------------------------------------------------
# 退出
# ---------------------------------------------------------------------------

@app.post("/api/shutdown")
def shutdown():
    """让 Tauri 关闭窗口时能优雅地结束 sidecar。"""
    global _uvicorn_server
    if _uvicorn_server is not None:
        _uvicorn_server.should_exit = True
    return {"ok": True}


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------

def main(argv: Optional[list[str]] = None) -> None:
    global TOKEN, _uvicorn_server

    parser = argparse.ArgumentParser(description="COMSOLPilot 桌面壳后端")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--token", default="", help="本地接口访问令牌（留空则不校验）")
    parser.add_argument("--core", default="", help="覆盖核心目录位置")
    parser.add_argument("--runtime", default="", help="安装包内置 Python 运行时")
    args = parser.parse_args(argv)

    if args.core:
        os.environ[paths.ENV_CORE] = args.core
    if args.runtime:
        os.environ[paths.ENV_RUNTIME] = args.runtime
    TOKEN = args.token or None

    core_bridge.ensure_windows_env()
    installed, detail = deps_installer.ensure_core_installed()
    if installed:
        # Keep the writable copy outside the installer's versioned resources.
        os.environ[paths.ENV_CORE] = detail
        deps_installer.select_default_environment()
    core_root = paths.core_root()
    print(f"[sidecar] 核心目录：{core_root}", flush=True)
    if not core_bridge.core_ready():
        print(f"[sidecar] 警告：{core_root / 'src' / 'server.py'} 不存在", flush=True)
    if TOKEN is None:
        print("[sidecar] 未启用 token 校验（手动运行模式）", flush=True)

    # 环境扫描要起子进程探测，放在后台预热，免得第一个请求白等几秒
    import threading

    threading.Thread(
        target=lambda: deps_installer.discover(refresh=True), daemon=True
    ).start()

    import uvicorn

    config = uvicorn.Config(app, host=args.host, port=args.port, log_level="info")
    _uvicorn_server = uvicorn.Server(config)
    print(f"[sidecar] 监听 http://{args.host}:{args.port}", flush=True)
    _uvicorn_server.run()


if __name__ == "__main__":
    main()
