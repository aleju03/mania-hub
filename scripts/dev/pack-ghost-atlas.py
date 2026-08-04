#!/usr/bin/env python3
"""Rebuild a ghost atlas (public/images/ghost/*.png) from a local DELTARUNE install.

Dev-only, run by hand, not part of any build: it needs the game installed and
Pillow, and it exists so a character's art has a provenance and a way back. The
clip specs at the bottom are the record of which sprite and which frames each
row of each atlas came from.

    python3 scripts/dev/pack-ghost-atlas.py dog starwalker

Then update the character's clips and bounds in src/lib/ghost-shared.ts with
what it prints, bump that character's atlas.version, and put the new digest in
src/lib/ghost-shared.test.ts. The version matters because the service worker
caches /images/* forever: art swapped under the same URL renders as fragments.

How it reads the game: data.win is a FORM of chunks. STRG holds strings, SPRT
the sprite table (name, size, origin, then one TPAG pointer per frame), TPAG a
rect on a texture page, and TXTR the pages themselves. The pages are QOI in the
original pre-1.0 spec (index/run8/run16/diff8/diff16/diff24/colour ops, XOR
hash), bz2-compressed behind a "2zoq" header, with the channels in RGBA order.
"""
import bz2
import io
import struct
import sys
from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image

GAME = Path.home() / ".local/share/Steam/steamapps/common/DELTARUNE"
CHAPTER = "chapter%d_windows/data.win"
OUT = Path(__file__).resolve().parents[2] / "public/images/ghost"
# Transparent margin kept around the packed art, in sprite pixels.
PAD = 2


# --------------------------------------------------------------------------
# data.win
# --------------------------------------------------------------------------

@dataclass
class TPag:
    sx: int; sy: int; sw: int; sh: int
    tx: int; ty: int; tw: int; th: int
    bw: int; bh: int; page: int


@dataclass
class Sprite:
    name: str
    width: int
    height: int
    frames: list = field(default_factory=list)


class GameData:
    def __init__(self, path):
        self.data = path.read_bytes()
        self.chunks = {}
        off, end = 8, 8 + self._u32(4)
        while off + 8 <= end:
            name = self.data[off:off + 4].decode("ascii", "replace")
            size = self._u32(off + 4)
            self.chunks[name] = (off + 8, size)
            off += 8 + size
        self._read_tpags()
        self._read_sprites()
        self._pages = {}
        self._blobs = self._texture_blobs()

    def _u32(self, o):
        return struct.unpack_from("<I", self.data, o)[0]

    def _string(self, ptr):
        # Pointers land on the characters; the length sits in front of them.
        return self.data[ptr:ptr + self._u32(ptr - 4)].decode("utf-8", "replace") if ptr else ""

    def _read_tpags(self):
        start, _ = self.chunks["TPAG"]
        self.tpag_by_ptr = {}
        for i in range(self._u32(start)):
            ptr = self._u32(start + 4 + i * 4)
            self.tpag_by_ptr[ptr] = TPag(*struct.unpack_from("<11H", self.data, ptr))

    def _read_sprites(self):
        start, _ = self.chunks["SPRT"]
        self.sprites = {}
        for i in range(self._u32(start)):
            sprite = self._read_sprite(self._u32(start + 4 + i * 4))
            self.sprites[sprite.name] = sprite

    def _read_sprite(self, o):
        name = self._string(self._u32(o))
        width, height = self._u32(o + 4), self._u32(o + 8)
        # name, size, 4 margins, 3 flags, bbox mode, sep masks, origin x/y.
        p = o + 56
        if struct.unpack_from("<i", self.data, p)[0] == -1:
            p += 4
            version = self._u32(p)
            kind = self._u32(p + 4)
            # playback speed and its type, then optional sequence / nine-slice
            p += 8 + 8
            if version >= 2:
                p += 4
                if version >= 3:
                    p += 4
            if kind != 0:  # not a plain raster sprite: nothing to pull out
                return Sprite(name, width, height, [])
        count = self._u32(p)
        if count > 4096:
            return Sprite(name, width, height, [])
        frames = [self.tpag_by_ptr.get(self._u32(p + 4 + i * 4)) for i in range(count)]
        return Sprite(name, width, height, [f for f in frames if f])

    def _texture_blobs(self):
        start, size = self.chunks["TXTR"]
        region = self.data[start:start + size]
        marks = []
        for magic in (b"\x89PNG\r\n\x1a\n", b"2zoq", b"fioq"):
            at = region.find(magic)
            while at != -1:
                marks.append((at, magic))
                at = region.find(magic, at + 1)
        marks.sort()
        return [
            (magic, region[at:marks[i + 1][0] if i + 1 < len(marks) else len(region)])
            for i, (at, magic) in enumerate(marks)
        ]

    def page(self, index):
        if index not in self._pages:
            magic, blob = self._blobs[index]
            if magic.startswith(b"\x89PNG"):
                self._pages[index] = Image.open(io.BytesIO(blob)).convert("RGBA")
            else:
                raw = bz2.decompress(blob[blob.find(b"BZh"):]) if magic == b"2zoq" else blob
                self._pages[index] = decode_qoi(raw)
        return self._pages[index]

    def frames(self, name):
        """Every frame of a sprite, each padded out to its bounding size."""
        sprite = self.sprites.get(name)
        if not sprite:
            raise SystemExit(f"no sprite named {name}")
        out = []
        for f in sprite.frames:
            canvas = Image.new("RGBA", (max(1, f.bw), max(1, f.bh)), (0, 0, 0, 0))
            canvas.paste(self.page(f.page).crop((f.sx, f.sy, f.sx + f.sw, f.sy + f.sh)), (f.tx, f.ty))
            out.append(canvas)
        return out


def decode_qoi(buf):
    """The original pre-1.0 QOI, which is the revision GameMaker shipped."""
    if buf[:4] != b"fioq":
        raise ValueError("not a GameMaker qoi blob")
    w, h = struct.unpack_from("<HH", buf, 4)
    stream = buf[12:]
    total = w * h
    pixels = bytearray(total * 4)
    index = [(0, 0, 0, 0)] * 64
    r, g, b, a = 0, 0, 0, 255
    p = i = 0
    while i < total and p < len(stream):
        byte = stream[p]; p += 1
        run = 0
        if byte & 0xC0 == 0x00:  # INDEX
            r, g, b, a = index[byte & 0x3F]
        elif byte & 0xE0 == 0x40:  # RUN_8
            run = (byte & 0x1F) + 1
        elif byte & 0xE0 == 0x60:  # RUN_16
            run = (((byte & 0x1F) << 8) | stream[p]) + 33; p += 1
        elif byte & 0xC0 == 0x80:  # DIFF_8
            r = (r + ((byte >> 4) & 0x03) - 2) & 0xFF
            g = (g + ((byte >> 2) & 0x03) - 2) & 0xFF
            b = (b + (byte & 0x03) - 2) & 0xFF
        elif byte & 0xE0 == 0xC0:  # DIFF_16
            second = stream[p]; p += 1
            r = (r + (byte & 0x1F) - 16) & 0xFF
            g = (g + ((second >> 4) & 0x0F) - 8) & 0xFF
            b = (b + (second & 0x0F) - 8) & 0xFF
        elif byte & 0xF0 == 0xE0:  # DIFF_24
            second, third = stream[p], stream[p + 1]; p += 2
            r = (r + ((((byte & 0x0F) << 1) | (second >> 7)) - 16)) & 0xFF
            g = (g + (((second >> 2) & 0x1F) - 16)) & 0xFF
            b = (b + ((((second & 0x03) << 3) | ((third >> 5) & 0x07)) - 16)) & 0xFF
            a = (a + ((third & 0x1F) - 16)) & 0xFF
        else:  # COLOUR: one flag per channel that follows
            if byte & 0x08:
                r = stream[p]; p += 1
            if byte & 0x04:
                g = stream[p]; p += 1
            if byte & 0x02:
                b = stream[p]; p += 1
            if byte & 0x01:
                a = stream[p]; p += 1
        if run:
            chunk = bytes((r, g, b, a)) * min(run, total - i)
            pixels[i * 4:i * 4 + len(chunk)] = chunk
            i += len(chunk) // 4
            continue
        index[(r ^ g ^ b ^ a) % 64] = (r, g, b, a)
        pixels[i * 4:i * 4 + 4] = bytes((r, g, b, a))
        i += 1
    return Image.frombytes("RGBA", (w, h), bytes(pixels))


# --------------------------------------------------------------------------
# packing
# --------------------------------------------------------------------------

# Several of the dog's frames share their rect on the Chapter 4 sheet with
# pixels that are not his: scanlines, dashes, whole blocks of somebody else's
# art. That is in the shipped pages rather than in the reading of them, and the
# checks that establish it are worth keeping written down, because the obvious
# assumption is a broken decoder:
#
#   - the decoder ends each page exactly on its last pixel having consumed
#     exactly its last byte, on every page;
#   - the TXTR table's 43 blob pointers resolve to the same 43 offsets the
#     frames are read from, so no page is off by one;
#   - an INDEX op is only ever emitted for a slot already holding that colour,
#     so hashing every INDEX hit back to its slot audits the running palette:
#     it agrees on all but a handful of ops, and those all land in the top ~60
#     rows of a page, nowhere near these sprites;
#   - spr_dogcar is packed in four different chapters, and the four copies come
#     back as the same car under four different intruders.
#
# So the frames have to be cleaned. Every rule below only ever keeps or drops
# pixels the game shipped; none of them paints anything new.

def keep_greyscale(img):
    """The Annoying Dog is white, black and grey. Dropping every coloured pixel
    takes the draped leash and the neighbouring art in its frame with it."""
    out = img.copy()
    px = out.load()
    for y in range(out.height):
        for x in range(out.width):
            r, g, b, a = px[x, y]
            if a and max(r, g, b) - min(r, g, b) > 24:
                px[x, y] = (0, 0, 0, 0)
    return out


def keep_warm(img):
    """The dog plus whatever warm-coloured thing it is holding: maracas, wooden
    stilts, a red car. Anything blue, green or magenta came from elsewhere."""
    out = img.copy()
    px = out.load()
    for y in range(out.height):
        for x in range(out.width):
            r, g, b, a = px[x, y]
            if not a:
                continue
            grey = max(r, g, b) - min(r, g, b) <= 24
            # Red enough to be the art, without letting magenta through.
            warm = r >= g and r >= b and b <= 0.6 * r
            if not (grey or warm):
                px[x, y] = (0, 0, 0, 0)
    return out


def largest_blob(img):
    """Keep only the biggest connected run of pixels. The dog and what it holds
    are one shape; a bar or a speck bleeding into the frame is its own."""
    from collections import deque
    px = img.load()
    w, h = img.size
    seen = [[False] * w for _ in range(h)]
    best = []
    for sy in range(h):
        for sx in range(w):
            if seen[sy][sx] or px[sx, sy][3] == 0:
                continue
            queue = deque([(sx, sy)])
            seen[sy][sx] = True
            found = []
            while queue:
                x, y = queue.popleft()
                found.append((x, y))
                for dx in (-1, 0, 1):
                    for dy in (-1, 0, 1):
                        nx, ny = x + dx, y + dy
                        if 0 <= nx < w and 0 <= ny < h and not seen[ny][nx] and px[nx, ny][3]:
                            seen[ny][nx] = True
                            queue.append((nx, ny))
            if len(found) > len(best):
                best = found
    out = Image.new("RGBA", img.size, (0, 0, 0, 0))
    target = out.load()
    for x, y in best:
        target[x, y] = px[x, y]
    return out


FIXES = {"grey": keep_greyscale, "warm": keep_warm, "blob": largest_blob}

# Clip-wide fixes, applied once the whole clip is in hand.
PALETTE_SHARE = 0.02
# How long a knocked-out run may be before it counts as the drawing.
COLUMN_FILL_MAX = 4


def clip_palette(images, share=PALETTE_SHARE):
    """The colours a clip is actually drawn in, counted only where the page is
    fully opaque. What bleeds into these frames arrives either at partial alpha
    or in colours the dog is never drawn in, so a share of the fully opaque
    pixels separates his palette from the rest without naming either: the
    stilts come back black, white and one wooden tan, the maracas add their
    yellow and orange."""
    counts = {}
    total = 0
    for img in images:
        for r, g, b, a in img.getdata():
            if a == 255:
                counts[(r, g, b)] = counts.get((r, g, b), 0) + 1
                total += 1
    return {colour for colour, n in counts.items() if n >= total * share}


def keep_clip_palette(images):
    """Drop every pixel that is not one of the clip's own colours at full
    alpha. This is the blunt half of the cleanup and it leaves holes; the
    repairs below close them from the frame's own surviving pixels."""
    palette = clip_palette(images)
    out = []
    for img in images:
        copy = Image.new("RGBA", img.size, (0, 0, 0, 0))
        src, dst = img.load(), copy.load()
        for y in range(img.height):
            for x in range(img.width):
                r, g, b, a = src[x, y]
                if a == 255 and (r, g, b) in palette:
                    dst[x, y] = (r, g, b, 255)
        out.append(copy)
    return out


def drop_full_width_rows(images):
    """A row opaque clear across everything the frame draws is a scanline from
    elsewhere on the sheet: the dog is a shape with a silhouette, so no row of
    his own reaches both edges of his own bounding box unbroken. Measured
    against that box rather than the padded frame, which is mostly margin."""
    out = []
    for img in images:
        copy = img.copy()
        px = copy.load()
        box = copy.getbbox()
        if box:
            left, _, right, _ = box
            for y in range(copy.height):
                if all(px[x, y][3] for x in range(left, right)):
                    for x in range(left, right):
                        px[x, y] = (0, 0, 0, 0)
        out.append(copy)
    return out


def repair_columns(images, fill=COLUMN_FILL_MAX, fill_colours=None):
    """Pull a clip back to the colours it is actually drawn in, taking each
    replacement from the same column.

    The stilts are black, white and one wooden tan, but nearly every frame
    arrived with something else bleeding along the poles: bands of the wrong
    colour, stretches at half alpha, and rows knocked out entirely. A column is
    the right place to look for the answer because a pole is one, and it has to
    run the whole column rather than a few rows: some of the damage is longer
    than the gaps between it. Order matters around this - pruning stray shapes
    before the poles are whole again takes the far side of a break with them."""
    palette = clip_palette(images)
    out = []
    for img in images:
        copy = img.copy()
        source = img.load()
        px = copy.load()
        for x in range(copy.width):
            def good(y):
                r, g, b, a = source[x, y]
                return (r, g, b) if a == 255 and (r, g, b) in palette else None

            column = [good(y) for y in range(copy.height)]
            seen = [colour for colour in column if colour]
            if not seen:
                continue
            for y in range(copy.height):
                if column[y]:
                    continue
                over = next((at for at in range(y - 1, -1, -1) if column[at]), None)
                under = next((at for at in range(y + 1, copy.height) if column[at]), None)
                above = column[over] if over is not None else None
                below = column[under] if under is not None else None
                if source[x, y][3] == 0:
                    # A row the bleed knocked out, but only a run the column
                    # agrees across and no longer than the clip allows. Four is
                    # right where a long gap is the drawing (the car's open
                    # window, the space under his raised arm); the stilts pass
                    # no limit at all, because a pole runs the whole frame and
                    # the damage to it is longer than any threshold. A clip can
                    # also name the colours worth closing a gap with: a hole in
                    # the dog's white body is damage, while the same gap ringed
                    # by his black outline is the background showing through.
                    gap = under - over - 1 if over is not None and under is not None else None
                    allowed = fill_colours is None or above in fill_colours
                    if above and above == below and allowed and gap is not None and (fill is None or gap <= fill):
                        px[x, y] = (*above, 255)
                    continue
                # Off-palette or washed out. Both neighbours agreeing settles
                # it; otherwise the colour this column is mostly made of wins,
                # which is the pole rather than whatever crossed it.
                pick = above if above == below else max(
                    [c for c in (above, below) if c], key=seen.count, default=None)
                px[x, y] = (*pick, 255) if pick else (0, 0, 0, 0)
        out.append(copy)
    return out


def repair_doubled(images):
    """The maracas frames are stored at 2x vertical scale: every row of the art
    is on the page twice, phase-locked to even rows. Pairing them up and
    diffing shows it plainly - 24 of 30 pairs identical on the even phase and
    none at all on the odd - and the bleed nearly always lands on one copy of a
    pair rather than both. So each row can be rebuilt pixel by pixel from
    whichever copy still holds one of the clip's own colours, which recovers
    the frame without inventing a thing: every pixel kept is a pixel the game
    shipped, just from the other half of the pair."""
    palette = clip_palette(images)
    drawn = lambda p: p[3] == 255 and p[:3] in palette
    out = []
    for img in images:
        px = img.load()
        w, h = img.size
        copy = img.copy()
        target = copy.load()
        for pair in range(h // 2):
            top = [px[x, pair * 2] for x in range(w)]
            bottom = [px[x, pair * 2 + 1] for x in range(w)]
            if top == bottom:
                continue
            # Where both copies survived but disagree, the row that caught
            # fewer of somebody else's pixels is the one to believe.
            spoilt = lambda row: sum(1 for p in row if p[3] and not drawn(p))
            cleaner = top if spoilt(top) <= spoilt(bottom) else bottom
            for x in range(w):
                a, b = top[x], bottom[x]
                if drawn(a) and not drawn(b):
                    pick = a
                elif drawn(b) and not drawn(a):
                    pick = b
                elif drawn(a) and drawn(b):
                    pick = a if a == b else cleaner[x]
                else:
                    pick = (0, 0, 0, 0)  # both copies lost: leave it to the column
                target[x, pair * 2] = pick
                target[x, pair * 2 + 1] = pick
        out.append(copy)
    return out


def repair_poles(images):
    return repair_columns(images, fill=None)


def repair_body(images):
    return repair_columns(images, fill=6, fill_colours={(255, 255, 255)})


CLIP_FIXES = {
    "palette": keep_clip_palette,
    "bars": drop_full_width_rows,
    "columns": repair_columns,
    "poles": repair_poles,
    "body": repair_body,
    "rows": repair_doubled,
}
_loaded = {}


def chapter(number):
    if number not in _loaded:
        _loaded[number] = GameData(GAME / (CHAPTER % number))
    return _loaded[number]


def build(spec):
    clips = []
    for name, sprite, indices, fps, native, *rest in spec["clips"]:
        options = rest[0] if rest else {}
        source = chapter(options.get("chapter", spec["chapter"])).frames(sprite)
        images = []
        for i in indices:
            img = source[i]
            if options.get("crop"):
                img = img.crop((0, options["crop"], img.width, img.height))
            for box in options.get("erase", []):
                img = img.copy()
                Image.Image.paste(img, Image.new("RGBA", (box[2] - box[0], box[3] - box[1])), box[:2])
            for fix in options.get("fix", []):
                img = FIXES[fix](img)
            images.append(img)
        for fix in options.get("clip_fix", []):
            images = CLIP_FIXES[fix](images)
        # Anything that has to wait for the clip to be whole again.
        for fix in options.get("post", []):
            images = [FIXES[fix](img) for img in images]
        # One box for the whole clip, so its frames never shift against each
        # other; per-frame boxes make a walk cycle jitter on the spot.
        box = None
        for img in images:
            b = img.getbbox()
            if b:
                box = b if box is None else (min(box[0], b[0]), min(box[1], b[1]),
                                             max(box[2], b[2]), max(box[3], b[3]))
        if box is None:
            raise SystemExit(f"clip {name} is empty")
        clips.append({"name": name, "fps": fps, "native": native, "images": images, "box": box})

    # Every clip stands bottom-centred on the anchor, which is what lets the
    # overlay switch clips without the character hopping.
    widest = max(c["box"][2] - c["box"][0] for c in clips)
    tallest = max(c["box"][3] - c["box"][1] for c in clips)
    frame_w = 2 * (widest // 2 + 1) + PAD * 2
    frame_h = tallest + PAD * 2
    anchor = (frame_w // 2, frame_h - PAD)
    cols = max(len(c["images"]) for c in clips)

    atlas = Image.new("RGBA", (frame_w * cols, frame_h * len(clips)), (0, 0, 0, 0))
    bounds = {}
    for row, clip in enumerate(clips):
        x0, y0, x1, y1 = clip["box"]
        left = anchor[0] - (x1 - x0) // 2 - ((x1 - x0) % 2)
        top = anchor[1] - (y1 - y0)
        for col, img in enumerate(clip["images"]):
            art = img.crop(clip["box"])
            atlas.paste(art, (col * frame_w + left, row * frame_h + top), art)
        bounds[clip["name"]] = (left, top, x1 - x0, y1 - y0)
    return atlas, clips, bounds, (frame_w, frame_h), anchor


SPECS = {
    "starwalker": {
        "chapter": 5,
        "clips": [
            ("idle", "spr_npc_originalstarwalker", [0], 1, "down"),
            ("walk", "spr_npc_originalstarwalker_walk_down", list(range(8)), 10, "down"),
            ("edge", "spr_npc_originalstarwalker_reveal", [0, 1], 6, "down"),
            ("final", "spr_npc_originalstarwalker_final", [0], 1, "down"),
            ("shadow", "spr_dw_churchb_starwalker", [0], 1, "down"),
        ],
    },
    "dog": {
        "chapter": 4,
        "clips": [
            ("idle", "spr_dog_walk", [0], 1, "left"),
            ("walk-left", "spr_dog_walk", [0, 1], 7, "left"),
            # The turnaround is 83px tall because the dog hangs off a leash:
            # crop to the dog, and the leash goes with the colours.
            ("walk-down", "spr_dog_turn_full", [23, 25], 7, "down", {"fix": ["grey"], "crop": 61}),
            ("walk-up", "spr_dog_turn_full", [8, 10], 7, "up", {"fix": ["grey"], "crop": 61}),
            ("sleep", "spr_dog_sleep", [0], 1, "left", {"fix": ["grey"]}),
            # The car, the maracas and both sets of stilts all arrived with
            # other parts of the sheet bleeding through them. Every one of them
            # starts by dropping to the clip's own colours, which is exact and
            # leaves holes, and then closes those holes from the frame itself:
            # "rows" from the other copy of the same row, "columns"/"poles"
            # from the rest of the column. Pruning stray shapes has to come
            # last - do it first and it takes the far side of every break.
            ("car", "spr_dogcar", [0, 1], 4, "left", {"clip_fix": ["palette", "columns"]}),
            # Frames 2 and 3 stay out: 3 is a head and a paw, and 2 keeps the
            # dog but lost the fill inside both maracas, on both copies of
            # every damaged row, so there is nothing left to put back. 0 and 1
            # come back whole - a shake with the maracas high and low.
            ("maracas", "spr_dog_dance", [0, 1], 5, "left",
             {"clip_fix": ["palette", "bars", "rows", "columns"], "post": ["blob"]}),
            # Frames 3 and 4 are past saving; 4 is the one whose poles come
            # back black. The other four are a stride.
            ("stilts", "spr_dog_stilts", [0, 1, 2, 5], 6, "left",
             {"clip_fix": ["palette", "poles"], "post": ["blob"]}),
            # 220px of stilt: he stands taller than most screens, which is the
            # joke. Same four frames, same repair.
            ("stilts-long", "spr_dog_stilts_long", [0, 1, 2, 5], 6, "left",
             {"clip_fix": ["palette", "poles"], "post": ["blob"]}),
        ],
    },
}


def main(names):
    for name in names or SPECS:
        atlas, clips, bounds, frame, anchor = build(SPECS[name])
        target = OUT / f"{name}.png"
        atlas.save(target, optimize=True)
        print(f"\n/* {name}: {target}, {atlas.width}x{atlas.height} */")
        print(f"frame: {{ w: {frame[0]}, h: {frame[1]} }}, anchor: {{ x: {anchor[0]}, y: {anchor[1]} }}")
        for row, clip in enumerate(clips):
            print(f'  {clip["name"]}: {{ row: {row}, frames: {len(clip["images"])}, '
                  f'fps: {clip["fps"]}, native: "{clip["native"]}" }},')
        for clip in clips:
            x, y, w, h = bounds[clip["name"]]
            print(f'  {clip["name"]}: {{ x: {x}, y: {y}, w: {w}, h: {h} }},')


if __name__ == "__main__":
    main(sys.argv[1:])
