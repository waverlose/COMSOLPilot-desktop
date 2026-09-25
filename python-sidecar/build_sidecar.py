"""把 sidecar 打成单文件 exe，同时供两种桌面外壳使用。

产物落两份，省得为了打包第二种外壳再跑一次 PyInstaller：

* `src-tauri/binaries/comsolpilot-sidecar-<triple>.exe` —— 给 Tauri 的 externalBin，
  文件名必须带目标三元组后缀；
* `resources/sidecar/comsolpilot-sidecar.exe` —— 给 Electron，由 electron-builder
  整目录复制进安装包的 `resources/sidecar/`，名字固定。

三件容易踩的事，这里都处理了：

1. **core 要一起打进去**。sidecar 只含 HTTP 层，真正的 COMSOL 逻辑在 `core/`，
   打包时必须作为数据文件带上，否则运行时找不到核心。但 `core/.venv` 是用户
   环境（几百 MB），绝不能进包——所以先复制一份「干净核心」到暂存目录再打包。
2. **保留控制台**。不要加 `--noconsole`/`--windowed`：那样 PyInstaller 会把
   `sys.stdout` 置为 None，uvicorn 的日志直接抛异常，而且外壳也收不到
   sidecar 的输出，日志页就空了。
3. **uvicorn 的动态导入**。它按字符串加载 loop / protocol / lifespan 实现，
   PyInstaller 静态分析看不到，用 `--collect-submodules` 兜住。

用法：
    python python-sidecar/build_sidecar.py
"""
from __future__ import annotations

import platform
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SIDECAR_DIR = ROOT / "python-sidecar"
CORE_DIR = ROOT / "core"
OUTPUT_DIR = ROOT / "src-tauri" / "binaries"
ELECTRON_DIR = ROOT / "resources" / "sidecar"
STAGING = ROOT / "build" / "core-bundle"
WORKPATH = ROOT / "build" / "pyinstaller"
SPECPATH = ROOT / "build"

BUNDLE_NAME = "comsolpilot-sidecar"

# 不进包：用户环境、缓存、运行期产物
EXCLUDE = shutil.ignore_patterns(
    ".venv", "__pycache__", "*.pyc", "logs", "models", "exports", "tmp", "cache", "target"
)


def target_triple() -> str:
    """Tauri 的 externalBin 要求文件名带目标三元组后缀。"""
    machine = platform.machine().lower()
    if machine in ("amd64", "x86_64"):
        return "x86_64-pc-windows-msvc"
    if machine in ("arm64", "aarch64"):
        return "aarch64-pc-windows-msvc"
    raise RuntimeError(f"暂不支持的架构：{machine}")


def stage_core() -> None:
    """把核心复制到暂存目录（排除用户环境与运行期产物）。"""
    if not (CORE_DIR / "src" / "server.py").is_file():
        raise RuntimeError(f"核心目录不完整：{CORE_DIR}")

    if STAGING.exists():
        shutil.rmtree(STAGING)
    STAGING.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(CORE_DIR, STAGING, ignore=EXCLUDE)
    # workspace 必须存在（哪怕是空的），运行时要往里写 settings.json / runtime.json
    (STAGING / "workspace").mkdir(parents=True, exist_ok=True)
    print(f"[build] 已暂存核心：{STAGING}")


def build() -> Path:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    WORKPATH.mkdir(parents=True, exist_ok=True)
    SPECPATH.mkdir(parents=True, exist_ok=True)

    command = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--onefile",
        "--name",
        BUNDLE_NAME,
        "--distpath",
        str(OUTPUT_DIR),
        "--workpath",
        str(WORKPATH),
        "--specpath",
        str(SPECPATH),
        "--paths",
        str(SIDECAR_DIR),
        "--add-data",
        f"{STAGING}{';' if platform.system() == 'Windows' else ':'}core",
        "--collect-submodules",
        "uvicorn",
        str(SIDECAR_DIR / "sidecar_server.py"),
    ]
    print("[build] " + " ".join(command))
    subprocess.run(command, cwd=str(ROOT), check=True)

    built = OUTPUT_DIR / f"{BUNDLE_NAME}.exe"
    if not built.is_file():
        built = OUTPUT_DIR / BUNDLE_NAME
    renamed = OUTPUT_DIR / f"{BUNDLE_NAME}-{target_triple()}.exe"
    shutil.move(str(built), str(renamed))
    return renamed


def publish_to_electron(source: Path) -> Path:
    """再放一份给 Electron。

    Tauri 的 externalBin 要求文件名带目标三元组后缀，Electron 那边则是固定名字、
    放在 `resources/sidecar/` 下由 electron-builder 整目录复制进安装包。
    """
    ELECTRON_DIR.mkdir(parents=True, exist_ok=True)
    suffix = ".exe" if platform.system() == "Windows" else ""
    target = ELECTRON_DIR / f"{BUNDLE_NAME}{suffix}"
    shutil.copy2(source, target)
    return target


def main() -> int:
    try:
        stage_core()
        output = build()
        electron_copy = publish_to_electron(output)
    except (RuntimeError, subprocess.CalledProcessError) as exc:
        print(f"[build] 失败：{exc}", file=sys.stderr)
        return 1
    print(f"[build] 已生成 sidecar（Tauri）：{output}")
    print(f"[build] 已复制给 Electron：{electron_copy}")
    print("[build] 接下来二选一：")
    print("[build]   Tauri    → npm run tauri:build")
    print("[build]   Electron → npm run electron:build")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
