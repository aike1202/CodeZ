from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "build"
SIZE = 1024
SCALE = 3


def lerp(a: int, b: int, t: float) -> int:
    return round(a + (b - a) * t)


def mix(c1: tuple[int, int, int], c2: tuple[int, int, int], t: float) -> tuple[int, int, int]:
    return tuple(lerp(a, b, t) for a, b in zip(c1, c2))


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def radial_background(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size))
    px = img.load()
    c0 = (30, 247, 255)
    c1 = (11, 124, 255)
    c2 = (16, 24, 44)
    c3 = (5, 7, 13)
    cx, cy = size * 0.34, size * 0.24
    max_r = size * 0.88
    for y in range(size):
      for x in range(size):
        d = math.hypot(x - cx, y - cy) / max_r
        if d < 0.31:
            color = mix(c0, c1, d / 0.31)
        elif d < 0.68:
            color = mix(c1, c2, (d - 0.31) / 0.37)
        else:
            color = mix(c2, c3, min(1, (d - 0.68) / 0.32))
        px[x, y] = (*color, 255)
    return img


def add_glow(base: Image.Image, layer: Image.Image, radius: int, opacity: float = 0.75) -> None:
    glow = layer.filter(ImageFilter.GaussianBlur(radius))
    if opacity < 1:
        alpha = glow.getchannel("A").point(lambda v: int(v * opacity))
        glow.putalpha(alpha)
    base.alpha_composite(glow)
    base.alpha_composite(layer)


def draw_icon() -> Image.Image:
    size = SIZE * SCALE
    img = radial_background(size)
    mask = rounded_mask(size, round(size * 0.21))
    img.putalpha(mask)

    draw = ImageDraw.Draw(img, "RGBA")
    pad = round(size * 0.035)
    draw.rounded_rectangle(
        (pad, pad, size - pad, size - pad),
        radius=round(size * 0.19),
        outline=(210, 255, 255, 120),
        width=round(size * 0.012),
    )

    shade = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shade, "RGBA")
    sd.polygon(
        [
            (0, round(size * 0.72)),
            (round(size * 0.44), round(size * 0.62)),
            (size, round(size * 0.44)),
            (size, size),
            (0, size),
        ],
        fill=(0, 18, 39, 130),
    )
    sd.polygon(
        [
            (0, 0),
            (round(size * 0.35), 0),
            (round(size * 0.54), round(size * 0.39)),
            (0, round(size * 0.83)),
        ],
        fill=(255, 255, 255, 18),
    )
    shade.putalpha(Image.composite(shade.getchannel("A"), Image.new("L", (size, size), 0), mask))
    img.alpha_composite(shade)

    glyph = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glyph, "RGBA")
    c_box = (
        round(size * 0.11),
        round(size * 0.24),
        round(size * 0.67),
        round(size * 0.76),
    )
    gd.arc(c_box, start=72, end=288, fill=(210, 252, 255, 255), width=round(size * 0.092))
    gd.arc(c_box, start=80, end=280, fill=(34, 218, 255, 255), width=round(size * 0.06))

    z = [
        (round(size * 0.43), round(size * 0.39)),
        (round(size * 0.79), round(size * 0.39)),
        (round(size * 0.76), round(size * 0.48)),
        (round(size * 0.55), round(size * 0.67)),
        (round(size * 0.72), round(size * 0.67)),
        (round(size * 0.69), round(size * 0.77)),
        (round(size * 0.34), round(size * 0.77)),
        (round(size * 0.37), round(size * 0.67)),
        (round(size * 0.58), round(size * 0.49)),
        (round(size * 0.40), round(size * 0.49)),
    ]
    gd.polygon(z, fill=(46, 224, 255, 255))
    gd.line(z + [z[0]], fill=(230, 255, 255, 170), width=round(size * 0.008), joint="curve")
    add_glow(img, glyph, round(size * 0.018), 0.82)

    circuits = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    cd = ImageDraw.Draw(circuits, "RGBA")
    line_w = round(size * 0.008)
    node_r = round(size * 0.015)
    lines = [
        ((0.29, 0.36), (0.20, 0.36)),
        ((0.28, 0.50), (0.16, 0.50)),
        ((0.30, 0.64), (0.22, 0.64)),
        ((0.73, 0.35), (0.82, 0.35)),
        ((0.70, 0.50), (0.84, 0.50)),
        ((0.73, 0.65), (0.82, 0.65)),
    ]
    for (x1, y1), (x2, y2) in lines:
        p1 = (round(size * x1), round(size * y1))
        p2 = (round(size * x2), round(size * y2))
        cd.line((p1, p2), fill=(126, 247, 255, 220), width=line_w)
        for p in (p2,):
            cd.ellipse((p[0] - node_r, p[1] - node_r, p[0] + node_r, p[1] + node_r), fill=(224, 252, 255, 245))
    center = (round(size * 0.5), round(size * 0.5))
    cd.ellipse(
        (center[0] - node_r * 2, center[1] - node_r * 2, center[0] + node_r * 2, center[1] + node_r * 2),
        fill=(8, 20, 36, 255),
        outline=(224, 252, 255, 255),
        width=round(size * 0.01),
    )
    add_glow(img, circuits, round(size * 0.012), 0.86)

    shine = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    sh = ImageDraw.Draw(shine, "RGBA")
    sh.pieslice(
        (round(size * -0.03), round(size * -0.20), round(size * 1.03), round(size * 0.68)),
        190,
        350,
        fill=(255, 255, 255, 26),
    )
    shine.putalpha(Image.composite(shine.getchannel("A"), Image.new("L", (size, size), 0), mask))
    img.alpha_composite(shine)

    return img.resize((SIZE, SIZE), Image.Resampling.LANCZOS)


def main() -> None:
    BUILD.mkdir(parents=True, exist_ok=True)
    icon = draw_icon()
    icon.save(BUILD / "icon.png")
    icon.save(
        BUILD / "icon.ico",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    icon.resize((512, 512), Image.Resampling.LANCZOS).save(BUILD / "icon-512.png")
    icon.resize((256, 256), Image.Resampling.LANCZOS).save(BUILD / "icon-256.png")
    print("Created build/icon.png, build/icon.ico, build/icon-512.png, build/icon-256.png")


if __name__ == "__main__":
    main()
