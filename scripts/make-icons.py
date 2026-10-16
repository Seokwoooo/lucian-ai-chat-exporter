"""Renders the extension icon (rounded square + "L" mark) at all required sizes with Pillow."""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "src" / "static" / "icons"
OUT.mkdir(parents=True, exist_ok=True)
S = 1024


def render() -> Image.Image:
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pad = int(S * 0.04)
    d.rounded_rectangle([pad, pad, S - pad, S - pad], radius=int(S * 0.24), fill=(23, 23, 26, 255))
    w = int(S * 0.105)
    x0, y0 = int(S * 0.355), int(S * 0.255)
    y1, x1 = int(S * 0.72), int(S * 0.665)
    ink = (255, 255, 255, 255)
    d.line([(x0, y0), (x0, y1)], fill=ink, width=w)
    d.line([(x0, y1), (x1, y1)], fill=ink, width=w)
    r = w // 2
    for (cx, cy) in [(x0, y0), (x0, y1), (x1, y1)]:
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=ink)
    # small accent dot (handoff spark)
    a = int(S * 0.07)
    cx, cy = int(S * 0.665), int(S * 0.32)
    d.ellipse([cx - a, cy - a, cx + a, cy + a], fill=(129, 140, 248, 255))
    return img


base = render()
for size in (16, 32, 48, 128):
    base.resize((size, size), Image.LANCZOS).save(OUT / f"icon-{size}.png", optimize=True)
base.resize((512, 512), Image.LANCZOS).save(OUT / "icon-512.png", optimize=True)
print("icons written to", OUT)
