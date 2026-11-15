"""Pads a companion model's textures: every UV island's colour bleeds out
into the unused space around it. Scanned models (the fumos) pack thousands of
islands on black, and mipmaps pull that black into the islands' edges, which
draws as dark lines at tile size. Needs numpy and Pillow.

    python3 -I scripts/dev/pad-companion-textures.py in.glb out.glb [preview-dir]
"""
import io, json, os, struct, sys

import numpy as np
from PIL import Image, ImageDraw
CT = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
NC = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}

def read(path):
    b = open(path, "rb").read()
    assert b[:4] == b"glTF"
    off, j, binc = 12, None, b""
    while off < len(b):
        ln, typ = struct.unpack("<II", b[off:off + 8])
        chunk = b[off + 8:off + 8 + ln]
        if typ == 0x4E4F534A: j = json.loads(chunk)
        elif typ == 0x004E4942: binc = chunk
        off += 8 + ln
    return j, bytearray(binc)

def accessor(j, binc, i):
    a = j["accessors"][i]
    bv = j["bufferViews"][a["bufferView"]]
    dt = np.dtype(CT[a["componentType"]]); n = NC[a["type"]]
    start = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
    stride = bv.get("byteStride", dt.itemsize * n)
    raw = np.frombuffer(bytes(binc), dtype=np.uint8, count=stride * (a["count"] - 1) + dt.itemsize * n, offset=start)
    rows = np.lib.stride_tricks.as_strided(raw, shape=(a["count"], dt.itemsize * n), strides=(stride, 1)).copy()
    arr = rows.view(dt).reshape(a["count"], n).astype(np.float64)
    if a.get("normalized"):
        arr = {np.int8: lambda x: np.maximum(x / 127, -1), np.uint8: lambda x: x / 255, np.int16: lambda x: np.maximum(x / 32767, -1), np.uint16: lambda x: x / 65535}[CT[a["componentType"]]](arr)
    return arr

def image_bytes(j, binc, k):
    bv = j["bufferViews"][j["images"][k]["bufferView"]]
    o = bv.get("byteOffset", 0)
    return bytes(binc[o:o + bv["byteLength"]])

def uv_tris_for_image(j, binc, img_index):
    """UV triangles (in 0..1) of every primitive whose base colour samples this image."""
    tex_ids = [t for t, tex in enumerate(j.get("textures", [])) if tex.get("source") == img_index or img_index in [e.get("source") for e in tex.get("extensions", {}).values()]]
    mats = []
    for m, mat in enumerate(j.get("materials", [])):
        pbr = mat.get("pbrMetallicRoughness", {})
        for bc in [pbr.get("baseColorTexture"), pbr.get("metallicRoughnessTexture"), mat.get("emissiveTexture"), mat.get("normalTexture"), mat.get("occlusionTexture")]:
            if bc and bc["index"] in tex_ids: mats.append((m, bc))
    out = []
    for mesh in j["meshes"]:
        for p in mesh["primitives"]:
            hit = [bc for m, bc in mats if p.get("material") == m]
            if not hit: continue
            bc = hit[0]
            uv = accessor(j, binc, p["attributes"][f"TEXCOORD_{bc.get('texCoord', 0)}"])
            tt = bc.get("extensions", {}).get("KHR_texture_transform")
            if tt:
                o = np.array(tt.get("offset", [0, 0])); s = np.array(tt.get("scale", [1, 1])); r = tt.get("rotation", 0)
                c, si = np.cos(r), np.sin(r)
                uv = uv * s
                uv = np.stack([c * uv[:, 0] + si * uv[:, 1], -si * uv[:, 0] + c * uv[:, 1]], 1) + o
            idx = accessor(j, binc, p["indices"]).astype(np.int64).ravel() if "indices" in p else np.arange(len(uv))
            out.append(uv[idx].reshape(-1, 3, 2))
    return np.concatenate(out) if out else np.zeros((0, 3, 2))

def coverage(tris, w, h, grow=1):
    m = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(m)
    for t in tris:
        pts = [(float(u) * w - 0.5, float(v) * h - 0.5) for u, v in t]
        d.polygon(pts, fill=255, outline=255)
    a = np.array(m) > 0
    for _ in range(grow):
        a = a | np.roll(a, 1, 0) | np.roll(a, -1, 0) | np.roll(a, 1, 1) | np.roll(a, -1, 1)
    return a

def wrap(tris):
    # a triangle past the 0..1 square samples the tile it lands in (REPEAT)
    shift = np.floor(tris.min(axis=1, keepdims=True))
    return tris - shift

def bleed(px, filled):
    px = px.astype(np.float32).copy()
    filled = filled.copy()
    h, w = filled.shape
    while not filled.all():
        acc = np.zeros_like(px); cnt = np.zeros((h, w), np.float32)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dy == 0 and dx == 0: continue
                f = np.roll(np.roll(filled, dy, 0), dx, 1)
                acc += np.roll(np.roll(px, dy, 0), dx, 1) * f[..., None]
                cnt += f
        grow = (~filled) & (cnt > 0)
        if not grow.any(): break
        px[grow] = acc[grow] / cnt[grow][:, None]
        filled |= grow
    return px

def rebuild(j, binc, replace):
    """New BIN with the given bufferView contents swapped in, every view realigned."""
    out = bytearray()
    for i, bv in enumerate(j["bufferViews"]):
        o = bv.get("byteOffset", 0)
        data = replace.get(i, bytes(binc[o:o + bv["byteLength"]]))
        while len(out) % 4: out.append(0)
        bv["byteOffset"] = len(out)
        bv["byteLength"] = len(data)
        out += data
    while len(out) % 4: out.append(0)
    j["buffers"][0]["byteLength"] = len(out)
    js = json.dumps(j, separators=(",", ":")).encode()
    js += b" " * ((4 - len(js) % 4) % 4)
    total = 12 + 8 + len(js) + 8 + len(out)
    return b"glTF" + struct.pack("<II", 2, total) + struct.pack("<II", len(js), 0x4E4F534A) + js + struct.pack("<II", len(out), 0x004E4942) + bytes(out)

def pad_glb(src, dst, preview_dir=None):
    j, binc = read(src)
    replace = {}
    for k, im in enumerate(j.get("images", [])):
        tris = uv_tris_for_image(j, binc, k)
        if len(tris) == 0: continue
        raw = image_bytes(j, binc, k)
        img = Image.open(io.BytesIO(raw))
        mode = "RGBA" if img.mode in ("RGBA", "LA", "P") and "A" in img.convert("RGBA").getbands() and np.array(img.convert("RGBA"))[..., 3].min() < 255 else "RGB"
        img = img.convert(mode)
        w, h = img.size
        cov = coverage(wrap(tris), w, h, grow=1)
        if cov.all(): continue
        px = bleed(np.array(img), cov)
        outimg = Image.fromarray(np.clip(np.rint(px), 0, 255).astype(np.uint8), mode)
        buf = io.BytesIO()
        fmt = {"image/webp": "WEBP", "image/png": "PNG", "image/jpeg": "JPEG"}[im["mimeType"]]
        outimg.save(buf, fmt, **({"quality": 90, "method": 6} if fmt == "WEBP" else {"quality": 92} if fmt == "JPEG" else {"optimize": True}))
        replace[im["bufferView"]] = buf.getvalue()
        if preview_dir:
            outimg.convert("RGB").resize((512, 512 * h // w)).save(os.path.join(preview_dir, f"{os.path.basename(src)[:-4]}-{k}.png"))
        print(f"  img{k} {w}x{h} filled {1 - cov.mean():.0%} of it, {len(raw)//1024} KB -> {len(replace[im['bufferView']])//1024} KB")
    if not replace: return False
    open(dst, "wb").write(rebuild(j, binc, replace))
    return True

if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit("usage: pad-companion-textures.py in.glb out.glb [preview-dir]")
    src, dst = sys.argv[1], sys.argv[2]
    print(os.path.basename(src))
    if not pad_glb(src, dst, sys.argv[3] if len(sys.argv) > 3 else None):
        print("  nothing to pad")
