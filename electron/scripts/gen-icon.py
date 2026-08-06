#!/usr/bin/env python3
"""Generate the Hertz app icon set with zero dependencies.

Pure-stdlib pipeline: rasterize 1024x1024 RGBA (rounded square + one
bezier stroke), bilinearly downsample every mac icon size, and build the
.icns via iconutil. Replaces qlmanage/sips, which both mangle alpha
channels.

Usage: python3 scripts/gen-icon.py <out-dir>
"""

import math
import os
import struct
import subprocess
import sys
import zlib

SIZE = 1024
R = 228  # corner radius (macOS-style ~22%)
STROKE = 52  # bezier stroke width
ICON_SIZES = [16, 32, 64, 128, 256, 512, 1024]

BG_TOP = (0x4F, 0x46, 0xE5)
BG_BOTTOM = (0x1E, 0x1B, 0x4B)
LINE_TOP = (0xFF, 0xFF, 0xFF)
LINE_BOTTOM = (0xA5, 0xB4, 0xFC)

P0 = (272, 656)
P1 = (380, 464)
P2 = (500, 464)
P3 = (512, 560)
P4 = (524, 656)
P5 = (644, 656)
P6 = (752, 464)


def bezier(points, t):
    pts = list(points)
    while len(pts) > 1:
        pts = [(lerp(a, b, t)) for a, b in zip(pts[:-1], pts[1:])]
    return pts[0]


def lerp(a, b, t):
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)


def round_rect_sdf(x, y):
    """Signed distance to the rounded rect (negative inside)."""
    px = abs(x - SIZE / 2)
    py = abs(y - SIZE / 2)
    half = SIZE / 2 - R
    qx = px - half
    qy = py - half
    dx = max(qx, 0.0)
    dy = max(qy, 0.0)
    return math.hypot(dx, dy) + min(max(qx, qy), 0.0) - R


def encode_png(px, size):
    """Encode RGBA8 raw bytes as a PNG (non-interlaced, filter 0)."""

    def chunk(typ, data):
        c = struct.pack(">I", len(data)) + typ + data
        return c + struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    raw = bytearray()
    for y in range(size):
        raw.append(0)
        raw += px[y * size * 4 : (y + 1) * size * 4]
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )


def downsample(px, size, target):
    """Bilinear downsample of premultiplied-safe RGBA (transparent corners
    carry RGB=0, so plain interpolation cannot bleed color)."""
    scale = size / target
    out = bytearray(target * target * 4)
    for ty in range(target):
        sy = (ty + 0.5) * scale - 0.5
        y0 = max(int(sy), 0)
        y1 = min(y0 + 1, size - 1)
        fy = sy - y0
        for tx in range(target):
            sx = (tx + 0.5) * scale - 0.5
            x0 = max(int(sx), 0)
            x1 = min(x0 + 1, size - 1)
            fx = sx - x0
            o = (ty * target + tx) * 4
            for c in range(4):
                a = px[(y0 * size + x0) * 4 + c] * (1 - fx) * (1 - fy)
                a += px[(y0 * size + x1) * 4 + c] * fx * (1 - fy)
                a += px[(y1 * size + x0) * 4 + c] * (1 - fx) * fy
                a += px[(y1 * size + x1) * 4 + c] * fx * fy
                out[o + c] = int(round(a))
    return out


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else "electron/build"

    # Sample the stroke into a polyline (endpoints get round caps).
    pts = [bezier([P0, P1, P2, P3], t) for t in (i / 200 for i in range(201))]
    pts += [bezier([P3, P4, P5, P6], t) for t in (i / 200 for i in range(1, 201))]

    # Bounding boxes per segment so we only compute distances near the line.
    segs = []
    for a, b in zip(pts[:-1], pts[1:]):
        x0, x1 = sorted((a[0], b[0]))
        y0, y1 = sorted((a[1], b[1]))
        pad = STROKE / 2 + 1.5
        segs.append((a, b, (int(x0 - pad), int(x1 + pad), int(y0 - pad), int(y1 + pad))))

    half_w = STROKE / 2
    px = bytearray(SIZE * SIZE * 4)

    for y in range(SIZE):
        for x in range(SIZE):
            # Background gradient (diagonal) clipped to the rounded rect.
            d = round_rect_sdf(x + 0.5, y + 0.5)
            t = (x + y) / (2 * SIZE)
            bg = tuple(int(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t) for i in range(3))
            bg_a = 1.0 if d <= 0 else max(0.0, 0.5 - d)

            # Stroke coverage: max distance-based coverage over segments
            # intersecting this pixel's AABB.
            cover = 0.0
            for a, b, (sx0, sx1, sy0, sy1) in segs:
                if not (sx0 <= x <= sx1 and sy0 <= y <= sy1):
                    continue
                # point-to-segment distance
                ax, ay = a
                bx, by = b
                abx, aby = bx - ax, by - ay
                tseg = ((x + 0.5 - ax) * abx + (y + 0.5 - ay) * aby) / max(abx * abx + aby * aby, 1e-12)
                tseg = max(0.0, min(1.0, tseg))
                cx, cy = ax + abx * tseg, ay + aby * tseg
                dist = math.hypot(x + 0.5 - cx, y + 0.5 - cy)
                c = half_w + 0.5 - dist
                if c > cover:
                    cover = c
            cover = max(0.0, min(1.0, cover))

            if cover <= 0.0:
                alpha = 0.0 if bg_a <= 0.0 else 255.0 * bg_a
                r, g, b = bg
            else:
                tline = y / SIZE
                line_col = tuple(int(LINE_TOP[i] + (LINE_BOTTOM[i] - LINE_TOP[i]) * tline) for i in range(3))
                # line alpha over background, both clipped by the rounded rect
                la = cover * bg_a
                ba = bg_a * (1.0 - cover)
                total = la + ba
                if total <= 0.0:
                    r = g = b = 0
                    alpha = 0.0
                else:
                    r = int((line_col[0] * la + bg[0] * ba) / total)
                    g = int((line_col[1] * la + bg[1] * ba) / total)
                    b = int((line_col[2] * la + bg[2] * ba) / total)
                    alpha = 255.0 * total

            o = (y * SIZE + x) * 4
            px[o] = int(r)
            px[o + 1] = int(g)
            px[o + 2] = int(b)
            px[o + 3] = int(alpha)

    # Encode every size; larger images downsample from the 1024 master.
    os.makedirs(out_dir, exist_ok=True)
    for target in ICON_SIZES:
        if target == SIZE:
            data = bytes(px)
        else:
            data = downsample(px, SIZE, target)
        png = encode_png(data, target)
        with open(os.path.join(out_dir, f"icon-{target}.png"), "wb") as f:
            f.write(png)

    # iconset (contents.json not needed for iconutil) + .icns + dev icon.png
    iconset = os.path.join(out_dir, "icon.iconset")
    if os.path.isdir(iconset):
        for f in os.listdir(iconset):
            os.remove(os.path.join(iconset, f))
    os.makedirs(iconset, exist_ok=True)
    for target in [16, 32, 64, 128, 256, 512]:
        for suffix, actual in (("", target), ("@2x", target * 2)):
            with open(os.path.join(out_dir, f"icon-{actual}.png"), "rb") as f:
                src = f.read()
            with open(os.path.join(iconset, f"icon_{target}x{target}{suffix}.png"), "wb") as f:
                f.write(src)
    subprocess.run(
        ["iconutil", "-c", "icns", iconset, "-o", os.path.join(out_dir, "icon.icns")],
        check=True,
    )
    import shutil

    shutil.copyfile(os.path.join(out_dir, "icon-512.png"), os.path.join(out_dir, "icon.png"))
    print(f"wrote icon set to {out_dir}")


if __name__ == "__main__":
    main()
