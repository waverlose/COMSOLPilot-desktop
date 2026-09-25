"""从一张设计稿生成各平台需要的图标文件。

Tauri（`src-tauri/icons/`）和 Electron（打包时 `resources/icon.ico`）都要吃这些文件，
仓库里不放二进制资源的话第一次打包必然失败。设计稿统一放在 `assets/app-icon.png`，
这个脚本负责裁切、缩放、拼多档 .ico。

用法：
    python scripts/generate_icons.py                     # 用 assets/app-icon.png
    python scripts/generate_icons.py path/to/other.png   # 换一张设计稿

没装 Pillow 会提示安装；设计稿不存在时退化成脚本内画的菱形标记，
保证仓库在任何状态下都能跑出可用的图标。
"""
from __future__ import annotations

import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw
except ImportError:
    print("需要 Pillow：pip install Pillow", file=sys.stderr)
    raise SystemExit(1)

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SOURCE = ROOT / "assets" / "app-icon.png"
ICONS_DIR = ROOT / "src-tauri" / "icons"
UI_ASSETS_DIR = ROOT / "src" / "assets"

# Tauri 的 tauri.conf.json 引用的这几个文件名
PNG_SIZES = {
    "32x32.png": 32,
    "128x128.png": 128,
    "128x128@2x.png": 256,
    "icon.png": 512,
}

# .ico 里塞多档尺寸：任务栏取 16/24，资源管理器取 32/48，开始菜单与大图标取 128/256
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

# 界面标题栏里显示的小图标。不直接引用 512 那张，省得为一个 16px 的位置下载 1MB。
UI_ICON_SIZE = 64

# 兜底标记的颜色，和 index.css 的 --accent 保持一致
ACCENT = (22, 101, 159, 255)  # #16659f
WHITE = (255, 255, 255, 255)
SUPERSAMPLE = 4


def draw_fallback(size: int) -> Image.Image:
    """没有设计稿时画一个「COMSOL 蓝圆角底 + 白菱形」。"""
    scale = size * SUPERSAMPLE
    canvas = Image.new("RGBA", (scale, scale), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)

    draw.rounded_rectangle(
        (0, 0, scale - 1, scale - 1), radius=int(scale * 0.22), fill=ACCENT
    )

    inset = scale * 0.30
    draw.polygon(
        [
            (scale / 2, inset),
            (scale - inset, scale / 2),
            (scale / 2, scale - inset),
            (inset, scale / 2),
        ],
        fill=WHITE,
    )
    return canvas.resize((size, size), Image.LANCZOS)


def load_source(path: Path) -> Image.Image | None:
    if not path.exists():
        return None
    try:
        image = Image.open(path)
    except OSError as error:
        print(f"读不了 {path}：{error}", file=sys.stderr)
        return None
    return image.convert("RGBA")


def square(image: Image.Image) -> Image.Image:
    """补成正方形。非正方形设计稿直接缩会被拉变形，宁可留透明边。"""
    width, height = image.size
    if width == height:
        return image

    side = max(width, height)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(image, ((side - width) // 2, (side - height) // 2))
    return canvas


def render(source: Image.Image, size: int) -> Image.Image:
    return source.resize((size, size), Image.LANCZOS)


def main(argv: list[str]) -> int:
    if len(argv) > 1:
        source_path = Path(argv[1]).expanduser().resolve()
    else:
        source_path = DEFAULT_SOURCE

    source = load_source(source_path)
    if source is None:
        print(f"没找到设计稿 {source_path}，改用脚本内画的兜底标记。")
        # 兜底图按最大尺寸画一次，再逐档缩，避免每档都重画
        base = draw_fallback(max(ICO_SIZES))
    else:
        base = square(source)
        print(f"设计稿 {source_path.name} {source.size[0]}x{source.size[1]}")

    ICONS_DIR.mkdir(parents=True, exist_ok=True)
    UI_ASSETS_DIR.mkdir(parents=True, exist_ok=True)

    print(f"\n生成到 {ICONS_DIR}")
    for name, size in PNG_SIZES.items():
        render(base, size).save(ICONS_DIR / name, format="PNG")
        print(f"  {name:<16} {size}x{size}")

    # .ico 必须从最大档生成，Pillow 会自己下采样出其它尺寸
    render(base, max(ICO_SIZES)).save(
        ICONS_DIR / "icon.ico",
        format="ICO",
        sizes=[(size, size) for size in ICO_SIZES],
    )
    print(f"  {'icon.ico':<16} {', '.join(str(s) for s in ICO_SIZES)}")

    # 界面标题栏用的小图标
    ui_target = UI_ASSETS_DIR / "app-icon.png"
    render(base, UI_ICON_SIZE).save(ui_target, format="PNG")
    print(f"\n生成到 {UI_ASSETS_DIR}")
    print(f"  {'app-icon.png':<16} {UI_ICON_SIZE}x{UI_ICON_SIZE}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
