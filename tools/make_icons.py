"""Draws the WHD tab icon as SVG and PNG from one shared geometry (64x64 units)."""
import math, struct, sys, zlib

OUT = sys.argv[1]

T, B, S = 23.0, 42.0, 4.8          # cap top, baseline, stroke width
MID = (T + B) / 2
# W: polyline through these points, clipped to [T, B]
W_PTS = [(6.6, T - 2), (11.2, B + 2), (15.5, T + 2.5), (19.8, B + 2), (24.4, T - 2)]
# H
H_L, H_R = 26.8, 40.2
# D
D_L, D_C, D_RX = 42.6, 49.6, 8.6
D_RY = (B - T) / 2

STOPS = [(0, (0x2f, 0x5f, 0x8a)), (0.45, (0x24, 0x4a, 0x6c)), (0.7, (0x2f, 0x5f, 0x8a)), (1, (0xc2, 0x69, 0x8a))]


def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def in_letters(x, y):
    if y < T or y > B:
        return False
    # W
    for (ax, ay), (bx, by) in zip(W_PTS, W_PTS[1:]):
        if seg_dist(x, y, ax, ay, bx, by) <= S / 2:
            return True
    # H
    if H_L <= x <= H_L + S or H_R - S <= x <= H_R:
        return True
    if H_L <= x <= H_R and abs(y - MID) <= S / 2:
        return True
    # D = outer minus inner
    def d_shape(left, top, bottom, rx, ry):
        if x < left or y < top or y > bottom:
            return False
        if x <= D_C:
            return True
        return ((x - D_C) / rx) ** 2 + ((y - MID) / ry) ** 2 <= 1
    if d_shape(D_L, T, B, D_RX, D_RY) and not d_shape(D_L + S, T + S, B - S, D_RX - S, D_RY - S):
        return True
    return False


def grad(u, v):
    # SVG linearGradient x1=0 y1=0 x2=1 y2=0.18 (objectBoundingBox)
    t = (u * 1 + v * 0.18) / (1 + 0.18 ** 2)
    t = max(0, min(1, t))
    for (t0, c0), (t1, c1) in zip(STOPS, STOPS[1:]):
        if t <= t1:
            f = (t - t0) / (t1 - t0)
            return tuple(c0[i] + (c1[i] - c0[i]) * f for i in range(3))
    return STOPS[-1][1]


def in_rounded(x, y, r):
    cx = min(max(x, r), 64 - r)
    cy = min(max(y, r), 64 - r)
    return math.hypot(x - cx, y - cy) <= r


def render(size, radius, ss=6):
    rows = []
    for py in range(size):
        row = bytearray([0])
        for px in range(size):
            text = mask = 0
            for sy in range(ss):
                for sx in range(ss):
                    x = (px + (sx + 0.5) / ss) * 64 / size
                    y = (py + (sy + 0.5) / ss) * 64 / size
                    if radius == 0 or in_rounded(x, y, radius):
                        mask += 1
                        if in_letters(x, y):
                            text += 1
            n = ss * ss
            a = mask / n
            ta = text / mask if mask else 0
            bg = grad((px + 0.5) / size, (py + 0.5) / size)
            rgb = [round(bg[i] * (1 - ta) + 255 * ta) for i in range(3)]
            row += bytes(rgb + [round(a * 255)])
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(kind, data):
        c = struct.pack(">I", len(data)) + kind + data
        return c + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def svg():
    f = lambda v: f"{v:g}"
    w = " ".join(f"{f(x)},{f(y)}" for x, y in W_PTS)
    d_outer = f"M{f(D_L)},{f(T)} H{f(D_C)} A{f(D_RX)},{f(D_RY)} 0 0 1 {f(D_C)},{f(B)} H{f(D_L)} Z"
    il, it, ib = D_L + S, T + S, B - S
    d_inner = f"M{f(il)},{f(it)} V{f(ib)} H{f(D_C)} A{f(D_RX - S)},{f(D_RY - S)} 0 0 0 {f(D_C)},{f(it)} Z"
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <!-- Browser-tab icon: the header's "The WHD" badge, simplified to "WHD"
       on the same accent-to-rose gradient (see .brand-mark in
       dashboard.css). Letters are drawn as shapes, not text, so they look
       the same on every computer. Generated together with favicon-32.png
       and apple-touch-icon.png, which use the same geometry. -->
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="0.18">
      <stop offset="0" stop-color="#2f5f8a" />
      <stop offset="0.45" stop-color="#244a6c" />
      <stop offset="0.7" stop-color="#2f5f8a" />
      <stop offset="1" stop-color="#c2698a" />
    </linearGradient>
    <clipPath id="caps"><rect x="0" y="{f(T)}" width="64" height="{f(B - T)}" /></clipPath>
  </defs>
  <rect width="64" height="64" rx="13" fill="url(#g)" />
  <g fill="#fff">
    <polyline points="{w}" fill="none" stroke="#fff" stroke-width="{f(S)}" stroke-linejoin="round" stroke-linecap="round" clip-path="url(#caps)" />
    <rect x="{f(H_L)}" y="{f(T)}" width="{f(S)}" height="{f(B - T)}" />
    <rect x="{f(H_R - S)}" y="{f(T)}" width="{f(S)}" height="{f(B - T)}" />
    <rect x="{f(H_L)}" y="{f(MID - S / 2)}" width="{f(H_R - H_L)}" height="{f(S)}" />
    <path fill-rule="evenodd" d="{d_outer} {d_inner}" />
  </g>
</svg>
'''


open(f"{OUT}/favicon.svg", "w").write(svg())
open(f"{OUT}/favicon-32.png", "wb").write(render(32, 13))
open(f"{OUT}/apple-touch-icon.png", "wb").write(render(180, 0))
open(f"{OUT}/preview-256.png", "wb").write(render(256, 13, ss=3))
print("done")
