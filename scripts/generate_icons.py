"""生成 Tauri 需要的图标文件。

`tauri build` 会去找 `src-tauri/icons/` 下的这几个文件，仓库里不放二进制资源的话
第一次打包必然失败。这里用 Pillow 直接画出来，省掉「先找一张 logo 图」这一步。

图形沿用界面里的品牌标记：陶土色圆角底 + 白色菱形。

用法：
    python scripts/generate_icons.py

想换成自己的 logo，用官方命令重新生成即可（会覆盖这里产出的文件）：
    npm run tauri icon path/to/your-logo.png
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
ICONS_DIR = ROOT / "src-tauri" / "icons"

ACCENT = (193, 95, 60, 255)  # #C15F3C，和 index.css 里的 --accent 一致
WHITE = (255, 255, 255, 255)

# Tauri 默认模板引用的这几个文件名
PNG_SIZES = {
    "32x32.png": 32,
    "128x128.png": 128,
    "128x128@2x.png": 256,
    "icon.png": 512,
}
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

# 超采样后再缩小，边缘才不会有锯齿
SUPERSAMPLE = 4


def render(size: int) -> Image.Image:
    scale = size * SUPERSAMPLE
    canvas = Image.new("RGBA", (scale, scale), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)

    # 圆角底：Tauri 图标本身不做圆角遮罩，但视觉上圆角更像一个应用图标
    radius = int(scale * 0.22)
    draw.rounded_rectangle((0, 0, scale - 1, scale - 1), radius=radius, fill=ACCENT)

    # 菱形（正方形旋转 45°）
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


def main() -> int:
    ICONS_DIR.mkdir(parents=True, exist_ok=True)

    for name, size in PNG_SIZES.items():
        render(size).save(ICONS_DIR / name, format="PNG")
        print(f"  {name:<16} {size}x{size}")

    # .ico 里塞多档尺寸，任务栏/资源管理器/开始菜单各取所需
    base = render(max(ICO_SIZES))
    base.save(
        ICONS_DIR / "icon.ico",
        format="ICO",
        sizes=[(s, s) for s in ICO_SIZES],
    )
    print(f"  {'icon.ico':<16} {', '.join(str(s) for s in ICO_SIZES)}")

    print(f"\n已生成到 {ICONS_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
