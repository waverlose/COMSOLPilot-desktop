"""Build a relocatable Windows Python runtime for the Tauri installer."""
from __future__ import annotations

import os
import platform
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
RUNTIME = ROOT / "build" / "runtime"
VERSION = "3.12.10"
ARCH = "amd64" if platform.machine().lower() in {"amd64", "x86_64"} else "arm64"
ARCHIVE = ROOT / "build" / f"python-{VERSION}-embed-{ARCH}.zip"
URL = f"https://www.python.org/ftp/python/{VERSION}/{ARCHIVE.name}"


def run(*args: str, cwd: Path | None = None, env: dict[str, str] | None = None) -> None:
    subprocess.run(args, cwd=cwd, env=env, check=True)


def main() -> int:
    if sys.platform != "win32":
        raise RuntimeError("The bundled runtime must be built on Windows")
    if sys.version_info[:2] != (3, 12):
        launchers: list[list[str]] = []
        configured = os.environ.get("COMSOLPILOT_BUILD_PYTHON", "").strip()
        if configured:
            launchers.append([configured])
        py = shutil.which("py")
        if py:
            launchers.append([py, "-3.12"])
        python312 = shutil.which("python3.12")
        if python312:
            launchers.append([python312])
        for launcher in launchers:
            try:
                return subprocess.call([*launcher, "-u", str(Path(__file__).resolve()), *sys.argv[1:]])
            except OSError:
                continue
        raise RuntimeError("Build with Python 3.12 so pip selects compatible wheels")
    RUNTIME.parent.mkdir(parents=True, exist_ok=True)
    if not ARCHIVE.is_file():
        print(f"[runtime] Downloading {URL}", flush=True)
        urllib.request.urlretrieve(URL, ARCHIVE)
    if RUNTIME.exists():
        shutil.rmtree(RUNTIME)
    RUNTIME.mkdir()
    with zipfile.ZipFile(ARCHIVE) as package:
        if not {"python.exe", "python312._pth", "python312.zip"}.issubset(package.namelist()):
            raise RuntimeError("Unexpected embedded Python archive")
        package.extractall(RUNTIME)

    # The embedded distribution ignores PYTHONPATH. sitecustomize adds only the
    # explicitly supplied core root, so MCP clients can find the writable copy.
    (RUNTIME / "python312._pth").write_text(
        "python312.zip\n.\nLib\\site-packages\nimport site\n", encoding="utf-8"
    )
    site = RUNTIME / "Lib" / "site-packages"
    site.mkdir(parents=True)
    shutil.copy2(ROOT / "python-sidecar" / "runtime_sitecustomize.py", site / "sitecustomize.py")
    run(sys.executable, "-m", "pip", "install", "--disable-pip-version-check",
        "--no-cache-dir", "--target", str(site), "-r",
        str(ROOT / "core" / "requirements-windows.txt"))

    python = RUNTIME / "python.exe"
    env = os.environ.copy()
    env["COMSOLPILOT_CORE"] = str(ROOT / "core")
    env["PYTHONUTF8"] = "1"
    check = (
        "import importlib.util, json, sys; "
        "from src.server import mcp, register_all_tools; "
        "register_all_tools(); "
        "assert all(importlib.util.find_spec(x) for x in ('mcp','mph','jpype','pydantic')); "
        "assert len(mcp._tool_manager._tools) > 0; "
        "print(json.dumps({'python':sys.version,'tools':len(mcp._tool_manager._tools)}))"
    )
    run(str(python), "-c", check, cwd=RUNTIME, env=env)
    print(f"[runtime] Ready: {python}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
