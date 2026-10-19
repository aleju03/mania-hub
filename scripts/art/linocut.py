"""Linocut print filter for the pack run's scene cards.

Turns an illustration into a one-ink print on a tinted paper chip that
matches the hand-coded SVG cards in src/components/packs/run/sceneArt.tsx:
subject crop to square, grayscale, local contrast, a two-tone posterize with
the mid-tones carved as parallel gouges (one fixed angle, or a few angles
chosen per area from the image gradient), rough cut edges, paper grain, and
the same rough rounded chip. Ink and paper colours are read from sceneArt.tsx.

  nice -n 10 python3 -I scripts/art/linocut.py --src <dir> [--only id,id] [--debug <dir>]

Sources are read as plain image data (PIL decodes them, nothing else). Output
is a 512px WebP per card in public/images/packs/scene/<id>.webp.
"""

from __future__ import annotations

import argparse
import math
import re
import zlib
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
SCENE_TSX = ROOT / "src/components/packs/run/sceneArt.tsx"
OUT_DIR = ROOT / "public/images/packs/scene"

OUT = 512  # output size
SS = 2  # supersampling for the cut edges
W = OUT * SS
U = W / 128  # one SVG viewBox unit in working pixels

Image.MAX_IMAGE_PIXELS = 40_000_000

# Per-image params. crop: source px (x0, y0, x1, y1), squared around its
# centre. lo / hi: tone below lo prints solid ink, above hi bare paper, the
# band between is gouged. gap: gouge spacing in output px. angle: gouge angle
# in degrees, or None to follow the image gradient. subject: polygon in crop
# coords 0..1 that keeps full detail; outside it the tone is pulled toward
# bg (0 ink .. 1 paper) by bg_mix. halo: width of a cleared line round the
# subject, in output px. curve: optional tone remap points [(in, out), ...].
# mix: RGB weights for the gray. reverse_x: crop fraction right of which the
# print is reversed.
PARAMS: dict[str, dict] = {
    "onceForgotten": dict(
        file="onceForgotten.png",
        crop=(160, 40, 350, 230),
        mix=(0.9, 0.4, -0.2),
        lo=0.30, hi=0.80, gap=6.0, angle=None, contrast=0.5, radius=24, smooth=1,
        detail=1.0, detail_r=6, lines=0.04,
        subject=[(0.36, 0.0), (0.66, 0.0), (0.70, 0.12), (0.74, 0.30), (0.88, 1.0), (0.14, 1.0), (0.24, 0.30), (0.30, 0.12)],
        bg=0.0, bg_mix=0.85, feather=4, halo=0.0, specks=0.0015,
    ),
    "futureDominators": dict(
        file="futureDominators.webp",
        crop=(400, 30, 1040, 670),
        lo=0.30, hi=0.78, gap=6.5, angle=None, contrast=0.6, radius=30, smooth=2, clean=3,
        subject=None, bg=1.0, bg_mix=0.0, halo=0.0, specks=0.0,
    ),
    "duplicity": dict(
        file="duplicity.jpg",
        crop=(730, 60, 1190, 520),
        reverse_x=0.5,
        lo=0.28, hi=0.70, gap=6.0, angle=None, contrast=0.6, radius=26, smooth=2,
        subject=None, bg=0.0, bg_mix=0.0, halo=0.0, specks=0.0,
    ),
    "echoes": dict(
        file="echoes.jpg",
        crop=(930, 270, 1530, 870),
        lo=0.30, hi=0.74, gap=6.0, angle=None, contrast=0.6, radius=26, smooth=2,
        subject=None, bg=0.0, bg_mix=0.0, halo=0.0, specks=0.0,
    ),
    "makiba": dict(
        file="makiba.png",
        crop=(0, 0, 200, 200),
        lo=0.35, hi=0.62, gap=6.0, angle=84, contrast=0.0, radius=20, smooth=2,
        # Black line art carves out of the green body; the white ground is paper.
        curve=[(0.0, 1.0), (0.25, 1.0), (0.45, 0.0), (0.85, 0.0), (0.95, 1.0), (1.0, 1.0)],
        subject=None, bg=1.0, bg_mix=0.0, halo=0.0, specks=0.0,
    ),
    # The girl right of centre, cropped close on her face; the hair at the
    # lower left is pulled to ink so the face carries the print.
    "aiae": dict(
        file="aiae.png",
        crop=(1070, 30, 1270, 230),
        lo=0.36, hi=0.70, gap=6.0, angle=None, contrast=0.5, radius=24, smooth=2, clean=3,
        detail=1.0, detail_r=3, lines=0.035,
        subject=[(0.40, 0.0), (0.88, 0.0), (0.95, 0.30), (0.85, 0.75), (0.78, 1.0), (0.0, 1.0), (0.0, 0.80), (0.18, 0.40), (0.30, 0.25)],
        bg=0.0, bg_mix=0.9, feather=6, halo=0.0, specks=0.0,
    ),
    # The girl with the sword, title text left out of the crop.
    "scatteredFaith": dict(
        file="scatteredFaith.jpg",
        crop=(40, 140, 640, 740),
        # Green-heavy: the red hair prints solid, so the pale face shows against it.
        mix=(0.1, 0.9, 0.0),
        lo=0.33, hi=0.66, gap=6.0, angle=None, contrast=0.5, radius=26, smooth=3, clean=3,
        detail=0.8, detail_r=4,
        subject=None, bg=0.0, bg_mix=0.0, halo=0.0, specks=0.0,
    ),
    # The keys that spell THE / KOXX.
    "foolMoon": dict(
        file="foolMoon.jpg",
        crop=(200, 170, 640, 600),
        lo=0.40, hi=0.70, gap=6.0, angle=0, contrast=0.4, radius=20, smooth=1,
        detail=1.0, detail_r=4, lines=0.03,
        subject=None, bg=1.0, bg_mix=0.0, halo=0.0, specks=0.0,
    ),
    # The elf in the rune ring: black line art on white, printed as cut lines.
    "moonGate": dict(
        file="moonGate.jpg",
        crop=(260, 140, 860, 740),
        lo=0.35, hi=0.62, gap=6.0, angle=84, contrast=0.0, radius=20, smooth=1,
        curve=[(0.0, 0.0), (0.62, 0.0), (0.88, 1.0), (1.0, 1.0)],
        subject=None, bg=1.0, bg_mix=0.0, halo=0.0, specks=0.0,
    ),
    # The seated figure with glasses and the red lantern; the logo stays out.
    "lostRequiem": dict(
        file="lostRequiem.jpg",
        crop=(480, 470, 960, 950),
        lo=0.22, hi=0.58, gap=6.0, angle=None, contrast=0.6, radius=26, smooth=2,
        detail=0.8, detail_r=4,
        # The rocks and moss behind are pulled to paper so the dark coat reads.
        subject=[(0.38, 0.08), (0.72, 0.06), (0.80, 0.30), (1.0, 0.45), (1.0, 1.0), (0.25, 1.0), (0.25, 0.80), (0.40, 0.55), (0.36, 0.30)],
        bg=1.0, bg_mix=0.75, feather=8, halo=0.0, specks=0.0,
    ),
    # The girl in the lab coat and glasses.
    "purplePalace": dict(
        file="purplePalace.jpg",
        crop=(1380, 100, 2020, 740),
        lo=0.34, hi=0.72, gap=6.0, angle=None, contrast=0.6, radius=26, smooth=2,
        detail=0.8, detail_r=4,
        # The gate and wall behind are pulled toward paper.
        subject=[(0.30, 0.0), (0.80, 0.0), (0.86, 0.30), (1.0, 0.60), (1.0, 1.0), (0.15, 1.0), (0.20, 0.60), (0.28, 0.30)],
        bg=1.0, bg_mix=0.4, feather=8, halo=0.0, specks=0.0,
    ),
}


# ---------- small numeric helpers ----------


def palette() -> dict[str, tuple[str, str]]:
    src = SCENE_TSX.read_text(encoding="utf-8")
    out = {}
    for m in re.finditer(r"^\s*(\w+): \{ ink: \"(#[0-9a-f]{6})\", paper: \"(#[0-9a-f]{6})\" \}", src, re.M):
        out[m.group(1)] = (m.group(2), m.group(3))
    return out


def rgb(hexstr: str) -> np.ndarray:
    return np.array([int(hexstr[i : i + 2], 16) for i in (1, 3, 5)], dtype=np.float32) / 255.0


def box(a: np.ndarray, r: int, axis: int) -> np.ndarray:
    if r < 1:
        return a
    pad = [(0, 0), (0, 0)]
    pad[axis] = (r + 1, r)
    p = np.pad(a, pad, mode="edge")
    c = np.cumsum(p, axis=axis, dtype=np.float64)
    n = a.shape[axis]
    hi = np.take(c, np.arange(2 * r + 1, 2 * r + 1 + n), axis=axis)
    lo = np.take(c, np.arange(0, n), axis=axis)
    return ((hi - lo) / (2 * r + 1)).astype(np.float32)


def blur(a: np.ndarray, sigma: float) -> np.ndarray:
    """Gaussian blur from three box passes."""
    if sigma <= 0:
        return a
    r = max(1, int(round(math.sqrt(12 * sigma * sigma / 3 + 1) / 2)))
    for _ in range(3):
        a = box(box(a, r, 0), r, 1)
    return a


def value_noise(rng: np.random.Generator, shape: tuple[int, int], cell: float) -> np.ndarray:
    h, w = shape
    gh, gw = max(2, int(h / cell) + 2), max(2, int(w / cell) + 2)
    g = rng.random((gh, gw), dtype=np.float32) * 2 - 1
    im = Image.fromarray(g, "F").resize((int(gw * cell), int(gh * cell)), Image.BICUBIC)
    return np.asarray(im, dtype=np.float32)[:h, :w]


def to_l(a: np.ndarray) -> Image.Image:
    return Image.fromarray(np.clip(a * 255 + 0.5, 0, 255).astype(np.uint8), "L")


def from_l(im: Image.Image) -> np.ndarray:
    return np.asarray(im, dtype=np.float32) / 255.0


# ---------- the chip (same shape as Plate.chip / BLOCK in sceneArt.tsx) ----------


def rrect_poly(x: float, y: float, w: float, h: float, r: float, step: float) -> list[tuple[float, float]]:
    pts = []
    for cx, cy, a0 in ((x + w - r, y + r, -90), (x + w - r, y + h - r, 0), (x + r, y + h - r, 90), (x + r, y + r, 180)):
        n = max(8, int(r * math.pi / 2 / step))
        for i in range(n):
            a = math.radians(a0 + 90 * i / n)
            pts.append((cx + math.cos(a) * r, cy + math.sin(a) * r))
        # straight edge to the next corner
    out = []
    for i, p in enumerate(pts):
        q = pts[(i + 1) % len(pts)]
        k = max(1, int(math.hypot(q[0] - p[0], q[1] - p[1]) / step))
        for j in range(k):
            out.append((p[0] + (q[0] - p[0]) * j / k, p[1] + (q[1] - p[1]) * j / k))
    return out


def rough_poly(pts: list[tuple[float, float]], rng: np.random.Generator, amp: float, wave: float, chips: float) -> list[tuple[float, float]]:
    """Wobble a clockwise polygon along its normals, with the odd inward nick."""
    n = len(pts)
    knots = rng.random(int(n / wave) + 3) * 2 - 1
    out = []
    chip = 0
    for i, p in enumerate(pts):
        a = pts[i - 1]
        b = pts[(i + 1) % n]
        dx, dy = b[0] - a[0], b[1] - a[1]
        ln = math.hypot(dx, dy) or 1.0
        u = i / wave
        k = int(u)
        f = u - k
        e = f * f * (3 - 2 * f)
        off = amp * (knots[k] * (1 - e) + knots[k + 1] * e)
        if chip <= 0 and rng.random() < chips:
            chip = int(2.5 * U / 2)
        if chip > 0:
            off -= 1.3 * amp + 0.6 * U
            chip -= 1
        # inward normal for a clockwise (screen coords) outline is (-dy, dx)
        out.append((p[0] - dy / ln * off, p[1] + dx / ln * off))
    return out


def poly_mask(pts: list[tuple[float, float]]) -> np.ndarray:
    im = Image.new("L", (W, W), 0)
    ImageDraw.Draw(im).polygon(pts, fill=255)
    return from_l(im)


# ---------- the print ----------


def load_crop(path: Path, crop: tuple[int, int, int, int], size: int, mix: tuple[float, float, float]) -> np.ndarray:
    with Image.open(path) as im:
        im.load()
        if im.mode in ("RGBA", "LA", "P"):
            im = im.convert("RGBA")
            bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
            im = Image.alpha_composite(bg, im)
        im = im.convert("RGB")
        x0, y0, x1, y1 = crop
        side = max(x1 - x0, y1 - y0)
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        box_ = (round(cx - side / 2), round(cy - side / 2), round(cx + side / 2), round(cy + side / 2))
        im = im.crop(box_).resize((size, size), Image.LANCZOS)
    a = np.asarray(im, dtype=np.float32) / 255.0
    # Rec. 709 luma by default; a card can weight the channels to split two
    # colours of the same lightness (white hair against pale skin).
    return np.clip(a[..., 0] * mix[0] + a[..., 1] * mix[1] + a[..., 2] * mix[2], 0, 1)


def gouge_field(g: np.ndarray, p: dict, rng: np.random.Generator) -> np.ndarray:
    """Distance (0 at a gouge centre, 1 midway between) to the nearest hatch line."""
    h, w = g.shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    period = p["gap"] * SS
    wob = value_noise(rng, g.shape, 22 * SS) * 0.18 * period + value_noise(rng, g.shape, 7 * SS) * 0.05 * period
    if p.get("angle") is not None:
        a = math.radians(p["angle"] + 90)
        phase = (xx * math.cos(a) + yy * math.sin(a) + wob) / period
    else:
        # Gouges run along the contours: a handful of angles, each area takes the
        # one closest to its smoothed gradient, so every patch is cut straight.
        s = blur(g, 2 * SS)
        gy, gx = np.gradient(s)
        sig = 10 * SS
        jxx, jyy, jxy = blur(gx * gx, sig), blur(gy * gy, sig), blur(gx * gy, sig)
        theta = 0.5 * np.arctan2(2 * jxy, jxx - jyy)  # gradient direction, mod pi
        coh = np.sqrt((jxx - jyy) ** 2 + 4 * jxy**2) / (jxx + jyy + 1e-6)
        k = p.get("bins", 4)
        base = math.radians(p.get("base_angle", 60) + 90)
        rel = (theta - base) % math.pi
        lab = np.round(rel / (math.pi / k)).astype(np.int32) % k
        lab = np.where(coh < 0.25, 0, lab)
        im = Image.fromarray((lab * (255 // k)).astype(np.uint8), "L")
        for _ in range(3):
            im = im.filter(ImageFilter.ModeFilter(9 * SS + 1))
        lab = np.round(np.asarray(im) / (255 // k)).astype(np.int32) % k
        phase = np.zeros_like(g)
        for i in range(k):
            a = base + i * math.pi / k
            ph = (xx * math.cos(a) + yy * math.sin(a) + wob) / period
            phase = np.where(lab == i, ph, phase)
    frac = phase - np.floor(phase)
    return np.abs(frac - 0.5) * 2  # 1 at the gouge centre, 0 between


def print_card(card: str, p: dict, ink_hex: str, paper_hex: str, debug: Path | None) -> Image.Image:
    rng = np.random.default_rng(zlib.crc32(card.encode()))
    # The printed block, as in sceneArt.tsx: BLOCK = rrect(9, 9, 110, 110, 8).
    bx = 9 * U
    bs = int(round(110 * U))
    g = load_crop(Path(p["path"]), p["crop"], bs, p.get("mix", (0.2126, 0.7152, 0.0722)))

    if p.get("curve"):
        xs, ys = zip(*p["curve"])
        g = np.interp(g, xs, ys).astype(np.float32)
    # Flatten texture, keep shapes.
    if p.get("smooth"):
        im = to_l(g)
        for _ in range(2):
            im = im.filter(ImageFilter.MedianFilter(p["smooth"] * SS + 1))
        g = from_l(im)
    # Local contrast: push each area away from its neighbourhood mean.
    if p.get("contrast"):
        m = blur(g, p["radius"] * SS)
        g = np.clip(m + (g - m) * (1 + p["contrast"]), 0, 1)
    # Fine detail (line art, closed eyes, folds) sharpened so it survives the cut.
    det = p.get("detail", 0.6)
    if det:
        g = np.clip(g + (g - blur(g, p.get("detail_r", 3) * SS)) * det, 0, 1)

    if p.get("subject"):
        poly = [(x * bs, y * bs) for x, y in p["subject"]]
        im = Image.new("L", (bs, bs), 0)
        ImageDraw.Draw(im).polygon(poly, fill=255)
        subj = blur(from_l(im), p.get("feather", 10) * SS)
        g = g * (subj + (1 - subj) * (1 - p["bg_mix"])) + (1 - subj) * p["bg_mix"] * p["bg"]
    else:
        subj = None

    # Two-tone with a gouged band. t is 0 at lo, 1 at hi, quantized to a few
    # gouge widths; the level map is cleaned before any gouge is cut, so the
    # cleanup takes specks off the shapes and never eats the gouges.
    rough = value_noise(rng, g.shape, 4 * SS) * 0.025 + value_noise(rng, g.shape, 1.5 * SS) * 0.012
    t = np.clip((g + rough - p["lo"]) / (p["hi"] - p["lo"]), 0, 1)
    steps = p.get("steps", 3)
    lv = np.round(t * steps).astype(np.uint8)
    im = Image.fromarray(lv * (255 // steps), "L").filter(ImageFilter.MedianFilter(p.get("clean", 2) * SS + 1))
    t = np.round(np.asarray(im, dtype=np.float32) / (255 // steps)) / steps
    gf = gouge_field(g, p, rng)
    # Paper where the gouge is wider than the ink left between. The narrowest
    # gouge and the narrowest ridge stay a printable width.
    paper = (gf > 1 - np.clip(t, 0.0, 1.0)).astype(np.float32)
    ink = np.where(t >= 1, 0.0, np.where(t <= 0, 1.0, 1 - paper)).astype(np.float32)

    if p.get("lines"):
        # Thin features (line art, closed eyes, strands) print as solid ridges
        # or clean gouges instead of breaking up into hatching.
        dog = blur(g, 0.8 * SS) - blur(g, p.get("detail_r", 3) * SS)
        dark = to_l((dog < -p["lines"]).astype(np.float32)).filter(ImageFilter.MedianFilter(3))
        light = to_l((dog > p["lines"] * 1.5).astype(np.float32)).filter(ImageFilter.MedianFilter(3))
        ink = np.maximum(ink, from_l(dark))
        ink = np.minimum(ink, 1 - from_l(light))

    # Take off specks smaller than the narrowest gouge.
    if p.get("speck", 2):
        ink = from_l(to_l(ink).filter(ImageFilter.MedianFilter(p.get("speck", 2) * SS + 1)))

    if p.get("reverse_x") is not None:
        # The right side prints reversed, cut along a slightly wavering line.
        cut = p["reverse_x"] * bs + value_noise(rng, g.shape, 12 * SS) * 1.2 * SS
        right = np.arange(bs, dtype=np.float32)[None, :] > cut
        ink = np.where(right, 1 - ink, ink)

    if subj is not None and p.get("halo"):
        edge = np.clip(1 - np.abs(subj - 0.5) * 2, 0, 1)
        ink = ink * (1 - (edge > 1 - p["halo"] * 0.12).astype(np.float32))

    if p.get("specks"):
        sp = (rng.random(g.shape) < p["specks"]).astype(np.float32)
        sp = from_l(to_l(sp).filter(ImageFilter.MaxFilter(3)))
        ink = ink * (1 - sp * (1 - (subj if subj is not None else 0)))

    if debug is not None:
        to_l(g).save(debug / f"{card}-gray.png")
        to_l(1 - ink).save(debug / f"{card}-mask.png")

    # Place the block on the chip.
    full = np.zeros((W, W), dtype=np.float32)
    o = int(round(bx))
    full[o : o + bs, o : o + bs] = ink
    block = rough_poly(rrect_poly(9 * U, 9 * U, 110 * U, 110 * U, 8 * U, 1.8 * U), rng, 0.4 * U, 3, 0)
    full *= poly_mask(block)
    chip_pts = rough_poly(rrect_poly(3 * U, 3 * U, 122 * U, 122 * U, 13 * U, 1.8 * U), rng, 0.6 * U, 3, 0)
    alpha = poly_mask(chip_pts)

    # Down to output size: antialiased edges.
    def down(a: np.ndarray) -> np.ndarray:
        return np.asarray(Image.fromarray(a.astype(np.float32), "F").resize((OUT, OUT), Image.BOX), dtype=np.float32)

    m = np.clip(down(full), 0, 1)
    alpha = np.clip(down(alpha), 0, 1)

    # Paper grain, and ink that did not quite take.
    grain = value_noise(rng, (OUT, OUT), 1.2) * 0.5 + value_noise(rng, (OUT, OUT), 5) * 0.5
    starve = np.clip(value_noise(rng, (OUT, OUT), 9) * 1.6 - 0.9, 0, 1) * 0.10 + np.clip(grain, 0, 1) * 0.06
    m = m * (1 - starve)
    INK, PAPER = rgb(ink_hex), rgb(paper_hex)
    paper_c = PAPER[None, None, :] * (1 + grain[..., None] * 0.018)
    col = paper_c * (1 - m[..., None]) + INK[None, None, :] * m[..., None]
    rgba = np.dstack([np.clip(col, 0, 1), alpha])
    return Image.fromarray((rgba * 255 + 0.5).astype(np.uint8), "RGBA")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="directory holding the source images")
    ap.add_argument("--only", default="")
    ap.add_argument("--out", default=str(OUT_DIR))
    ap.add_argument("--debug", default="")
    args = ap.parse_args()
    pal = palette()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    debug = Path(args.debug) if args.debug else None
    if debug:
        debug.mkdir(parents=True, exist_ok=True)
    only = {s for s in args.only.split(",") if s}
    for card, p in PARAMS.items():
        if only and card not in only:
            continue
        src = Path(args.src) / p["file"]
        if not src.is_file():
            print(f"skip {card}: no {src}")
            continue
        ink, paper = pal[card]
        img = print_card(card, {**p, "path": src}, ink, paper, debug)
        dest = out / f"{card}.webp"
        img.save(dest, "WEBP", quality=88, method=6)
        print(f"{dest} {dest.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
