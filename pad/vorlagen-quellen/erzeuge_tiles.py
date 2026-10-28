"""Erzeugt die Pixel-Texturen des Themes „Blockwelt“ (pad/public/tiles/*.png).
32×32 Pixel je Kachel, ohne Glättung 4× vergrößert (128×128), damit sie auch auf Retina-Bildschirmen scharf sind.
Aufruf: python3 erzeuge_tiles.py ../public/tiles"""
import random, sys, os
from PIL import Image

N, SCALE = 32, 4
out = sys.argv[1] if len(sys.argv) > 1 else "tiles"
os.makedirs(out, exist_ok=True)

def clamp(c): return tuple(max(0, min(255, int(v))) for v in c)
def shade(c, f): return clamp(tuple(v * f for v in c))
def noise(seed):
    r = random.Random(seed)
    g = [[r.random() for _ in range(N)] for _ in range(N)]
    # leicht glätten (kachelbar), damit Flecken statt Rauschen entstehen
    return [[(g[y][x] * 2 + g[y][(x + 1) % N] + g[(y + 1) % N][x] + g[y][(x - 1) % N] + g[(y - 1) % N][x]) / 6 for x in range(N)] for y in range(N)]

def save(name, px):
    im = Image.new("RGB", (N, N))
    for y in range(N):
        for x in range(N): im.putpixel((x, y), px[y][x])
    im.resize((N * SCALE, N * SCALE), Image.NEAREST).save(os.path.join(out, name + ".png"), optimize=True)

def palette(levels, v):
    return levels[min(len(levels) - 1, int(v * len(levels)))]

def dirt_px(seed, base=(134, 96, 67)):
    r = random.Random(seed); n = noise(seed)
    lv = [shade(base, f) for f in (0.72, 0.84, 0.95, 1.05, 1.16)]
    px = [[palette(lv, n[y][x] * 0.9 + r.random() * 0.25) for x in range(N)] for y in range(N)]
    for _ in range(9):  # Steinchen
        x, y = r.randrange(N), r.randrange(N)
        c = r.choice([(150, 150, 150), (120, 120, 120), (96, 70, 48)])
        for dx, dy in ((0, 0), (1, 0), (0, 1)):
            if r.random() < .85: px[(y + dy) % N][(x + dx) % N] = c
    return px

def grass_px(seed):
    r = random.Random(seed); px = dirt_px(seed + 1); n = noise(seed + 7)
    greens = [(74, 128, 40), (89, 148, 50), (104, 166, 60), (120, 184, 72), (138, 199, 84)]
    edge = []
    for x in range(N):
        e = 7 + r.choice([0, 0, 1, 1, 2, 3]) + (2 if r.random() < .18 else 0)
        edge.append(e)
    for x in range(N):
        for y in range(edge[x]):
            px[y][x] = palette(greens, n[y][x] * 0.8 + r.random() * 0.3)
        px[edge[x]][x] = shade(greens[0], 0.75)  # dunkle Kante unter dem Gras
    return px

def bricks_px(seed, base, mortar):
    r = random.Random(seed); n = noise(seed)
    px = [[mortar for _ in range(N)] for _ in range(N)]
    for row in range(4):
        y0 = row * 8; off = 0 if row % 2 == 0 else 8
        for b in range(2):
            x0 = (b * 16 + off) % N
            f = r.uniform(0.9, 1.08)
            for yy in range(1, 8):
                for xx in range(1, 16):
                    x, y = (x0 + xx) % N, y0 + yy
                    v = n[y][x] * 0.5 + r.random() * 0.25
                    c = shade(base, f * (0.88 + v * 0.3))
                    if yy == 1 or xx == 1: c = shade(c, 1.18)       # Licht oben/links
                    if yy == 7 or xx == 15: c = shade(c, 0.78)      # Schatten unten/rechts
                    px[y][x] = c
            for _ in range(2):  # Risse
                cx, cy = (x0 + r.randrange(3, 13)) % N, y0 + r.randrange(2, 6)
                for k in range(r.randrange(2, 4)):
                    if cy + k < y0 + 7: px[cy + k][(cx + (k % 2)) % N] = shade(base, 0.62)
    return px

def planks_px(seed, base, line):
    r = random.Random(seed); n = noise(seed)
    px = [[base] * N for _ in range(N)]
    for row in range(4):
        y0 = row * 8; seam = (row * 11 + 5) % N
        f = r.uniform(0.92, 1.06)
        for yy in range(8):
            for x in range(N):
                y = y0 + yy
                grain = 0.94 + 0.08 * ((x * 3 + y * 7 + int(n[y][x] * 10)) % 5 == 0) - 0.06 * ((x + yy * 5) % 9 == 0)
                c = shade(base, f * grain * (0.95 + n[y][x] * 0.12))
                if yy == 0: c = shade(c, 1.12)
                if yy == 7: c = line
                if x == seam: c = shade(line, 1.15)
                px[y][x] = c
        for nx in ((seam + 2) % N, (seam - 2) % N):  # Nägel
            px[y0 + 3][nx] = shade(line, 0.8)
    return px

save("grass", grass_px(11))
save("dirt", dirt_px(21))
save("stonebricks", bricks_px(31, (128, 128, 128), (82, 82, 82)))
save("deepslatebricks", bricks_px(41, (62, 62, 72), (30, 30, 36)))
save("planks", planks_px(51, (184, 148, 95), (112, 84, 48)))
save("darkplanks", planks_px(61, (74, 50, 28), (34, 22, 11)))
print("fertig:", sorted(os.listdir(out)))
