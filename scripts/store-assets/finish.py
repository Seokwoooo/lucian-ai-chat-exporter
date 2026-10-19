"""Finishes the store images rendered by compose.mjs.

- 2x renders -> exact store size (Lanczos), flattened to 24-bit RGB PNG (no alpha channel).
- Store icon: the package icon-128.png (96x96 artwork + 16 px transparent padding, made by
  scripts/make-icons.py), checked and copied.

usage: python3 finish.py <jobs.json> <icon-128.png> <store-icon-128.png>
"""

import json
import sys

from PIL import Image


def finish(jobs_path):
    for src, dst, w, h in json.load(open(jobs_path)):
        im = Image.open(src).convert("RGB").resize((w, h), Image.LANCZOS)
        im.save(dst, "PNG", optimize=True)
        print(f"  {dst}  {im.size[0]}x{im.size[1]} {im.mode}")


def store_icon(src, dst):
    """The store icon is the package icon (scripts/make-icons.py already follows the store guide)."""
    im = Image.open(src).convert("RGBA")
    box = im.getchannel("A").getbbox()
    assert im.size == (128, 128), f"{src}: expected 128x128, got {im.size}"
    assert box[0] >= 8 and box[1] >= 8 and box[2] <= 120 and box[3] <= 120, f"{src}: artwork not padded ({box})"
    im.save(dst, "PNG", optimize=True)
    print(f"  {dst}  128x128 RGBA (copied from {src})")


if __name__ == "__main__":
    finish(sys.argv[1])
    store_icon(sys.argv[2], sys.argv[3])
