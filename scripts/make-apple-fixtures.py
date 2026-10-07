#!/usr/bin/env python3
"""
Regenerate the HEIC fixtures under tests/fixtures/.

The browser suite cannot make these itself: headless Chromium on Linux has no
HEVC encoder, so a test that needed one would always skip. They are made here,
once, with real encoders, and committed.

    pip install pillow pillow-heif     # pillow-heif bundles libheif + x265
    python3 scripts/make-apple-fixtures.py

ffmpeg with libx265 must be on PATH for hevc-tiles.json.

  p3.heic          64x48, four vertical patches in Display P3 (values below),
                   with a matrix/TRC Display P3 ICC profile in its colr box —
                   which is what an iPhone writes.
  alpha.heic       32x32 RGBA: left half opaque, right half alpha 64.
  hevc-tiles.json  Eight 64x64 HEVC intra pictures from ONE encoder session, so
                   they share a single hvcC — exactly what WebCodecs hands
                   heif-write.js. The first four are solid colour tiles, the
                   last four solid grey tiles for an alpha plane. Full-range
                   BT.709, as recorded in the file.
"""
import base64
import json
import math
import os
import struct
import subprocess
import sys
import tempfile

from PIL import Image
import pillow_heif

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'tests', 'fixtures')

P3_PATCHES = [(255, 0, 0), (0, 255, 0), (200, 120, 60), (128, 128, 128)]
TILE_COLOURS = [(220, 40, 40), (40, 200, 60), (50, 70, 210), (240, 220, 30)]
ALPHA_LEVELS = [255, 128, 0, 200]


# --------------------------------------------------------------------------
# A Display P3 matrix/TRC ICC v2 profile, built from the primaries
# --------------------------------------------------------------------------

def mat_mul(a, b):
    return [[sum(a[i][k] * b[k][j] for k in range(3)) for j in range(3)] for i in range(3)]


def mat_vec(m, v):
    return [sum(m[i][k] * v[k] for k in range(3)) for i in range(3)]


def mat_inv(m):
    a, b, c = m[0]
    d, e, f = m[1]
    g, h, i = m[2]
    det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
    return [
        [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det],
        [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
        [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det],
    ]


def p3_colorants_d50():
    prim = [(0.680, 0.320), (0.265, 0.690), (0.150, 0.060)]
    white = (0.3127, 0.3290)
    cols = [[x / y, 1.0, (1 - x - y) / y] for x, y in prim]
    m = [[cols[j][i] for j in range(3)] for i in range(3)]
    wv = [white[0] / white[1], 1.0, (1 - white[0] - white[1]) / white[1]]
    s = mat_vec(mat_inv(m), wv)
    rgb_to_xyz = [[m[i][j] * s[j] for j in range(3)] for i in range(3)]
    brad = [[0.8951, 0.2664, -0.1614], [-0.7502, 1.7135, 0.0367], [0.0389, -0.0685, 1.0296]]
    d50 = [0.9642, 1.0, 0.8249]
    src = mat_vec(brad, wv)
    dst = mat_vec(brad, d50)
    scale = [[dst[i] / src[i] if i == j else 0 for j in range(3)] for i in range(3)]
    adapt = mat_mul(mat_inv(brad), mat_mul(scale, brad))
    m50 = mat_mul(adapt, rgb_to_xyz)
    return [[m50[0][j], m50[1][j], m50[2][j]] for j in range(3)]


def s15(v):
    return struct.pack('>i', int(round(v * 65536)))


def xyz_tag(xyz):
    return b'XYZ ' + b'\0' * 4 + b''.join(s15(c) for c in xyz)


def desc_tag(text):
    raw = text.encode('ascii') + b'\0'
    return b'desc' + b'\0' * 4 + struct.pack('>I', len(raw)) + raw + b'\0' * (4 + 4 + 2 + 1 + 67)


def para_srgb():
    # Parametric curve type 3: the sRGB EOTF.
    params = [2.4, 1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045]
    return b'para' + b'\0' * 4 + struct.pack('>H', 3) + b'\0\0' + b''.join(s15(p) for p in params)


def build_p3_icc():
    r, g, b = p3_colorants_d50()
    trc = para_srgb()
    tags = [
        (b'desc', desc_tag('Display P3')),
        (b'wtpt', xyz_tag([0.9642, 1.0, 0.8249])),
        (b'rXYZ', xyz_tag(r)), (b'gXYZ', xyz_tag(g)), (b'bXYZ', xyz_tag(b)),
        (b'rTRC', trc), (b'gTRC', trc), (b'bTRC', trc),
        (b'cprt', b'text' + b'\0' * 4 + b'No copyright, use freely\0'),
    ]
    table_len = 4 + 12 * len(tags)
    offset = 128 + table_len
    table, data = b'', b''
    for sig, body in tags:
        while (offset + len(data)) % 4:
            data += b'\0'
        table += sig + struct.pack('>II', offset + len(data), len(body))
        data += body
    body = struct.pack('>I', len(tags)) + table + data
    size = 128 + len(body)
    header = bytearray(128)
    struct.pack_into('>I', header, 0, size)
    header[8:12] = bytes([2, 0x10, 0, 0])
    header[12:16] = b'mntr'
    header[16:20] = b'RGB '
    header[20:24] = b'XYZ '
    header[36:40] = b'acsp'
    header[68:80] = s15(0.9642) + s15(1.0) + s15(0.8249)
    return bytes(header) + body


# --------------------------------------------------------------------------
# HEIC files through libheif + x265
# --------------------------------------------------------------------------

def make_p3():
    w, h = 64, 48
    img = Image.new('RGB', (w, h))
    px = img.load()
    for x in range(w):
        for y in range(h):
            px[x, y] = P3_PATCHES[x * len(P3_PATCHES) // w]
    heif = pillow_heif.from_pillow(img)
    heif.info['icc_profile'] = build_p3_icc()
    heif.save(os.path.join(OUT, 'p3.heic'), quality=95, chroma=444)


def make_alpha():
    img = Image.new('RGBA', (32, 32), (30, 120, 220, 255))
    px = img.load()
    for x in range(16, 32):
        for y in range(32):
            px[x, y] = (30, 120, 220, 64)
    pillow_heif.from_pillow(img).save(os.path.join(OUT, 'alpha.heic'), quality=95, chroma=444)


# --------------------------------------------------------------------------
# Raw tiles: x265 into an MP4, then read hvcC and the samples back out
# --------------------------------------------------------------------------

def boxes(buf, start, end):
    i = start
    while i + 8 <= end:
        size, kind = struct.unpack('>I4s', buf[i:i + 8])
        head = 8
        if size == 1:
            size = struct.unpack('>Q', buf[i + 8:i + 16])[0]
            head = 16
        elif size == 0:
            size = end - i
        yield kind.decode('latin1'), i + head, i + size
        i += size


def child(buf, start, end, *path):
    for name in path:
        for kind, s, e in boxes(buf, start, end):
            if kind == name:
                start, end = s, e
                break
        else:
            raise SystemExit(f'no {name} box')
    return start, end


def read_mp4(path):
    buf = open(path, 'rb').read()
    stbl = child(buf, 0, len(buf), 'moov', 'trak', 'mdia', 'minf', 'stbl')
    s, e = child(buf, *stbl, 'stsd')
    entry_start = s + 8                       # full box header + entry_count
    _, hvc1_body, hvc1_end = next(boxes(buf, entry_start, e))
    hs, he = child(buf, hvc1_body + 78, hvc1_end, 'hvcC')
    hvcc = buf[hs:he]

    s, e = child(buf, *stbl, 'stsz')
    fixed, count = struct.unpack('>II', buf[s + 4:s + 12])
    sizes = [fixed] * count if fixed else list(struct.unpack(f'>{count}I', buf[s + 12:s + 12 + 4 * count]))
    s, e = child(buf, *stbl, 'stco')
    n = struct.unpack('>I', buf[s + 4:s + 8])[0]
    offsets = list(struct.unpack(f'>{n}I', buf[s + 8:s + 8 + 4 * n]))
    s, e = child(buf, *stbl, 'stsc')
    n = struct.unpack('>I', buf[s + 4:s + 8])[0]
    runs = [struct.unpack('>III', buf[s + 8 + 12 * k:s + 20 + 12 * k]) for k in range(n)]

    samples, idx = [], 0
    for c, off in enumerate(offsets, start=1):
        per = next(spc for first, spc, _ in reversed(runs) if first <= c)
        for _ in range(per):
            samples.append(buf[off:off + sizes[idx]])
            off += sizes[idx]
            idx += 1
    return hvcc, samples


def make_tiles():
    size = 64
    frames = [c for c in TILE_COLOURS] + [(a, a, a) for a in ALPHA_LEVELS]
    raw = b''.join(bytes(c) * (size * size) for c in frames)
    with tempfile.TemporaryDirectory() as tmp:
        mp4 = os.path.join(tmp, 'tiles.mp4')
        subprocess.run([
            'ffmpeg', '-v', 'error', '-y',
            '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{size}x{size}', '-r', '1', '-i', '-',
            '-vf', 'scale=out_color_matrix=bt709:out_range=full,format=yuv420p',
            '-c:v', 'libx265', '-x265-params', 'keyint=1:log-level=error', '-crf', '4',
            '-color_range', 'pc', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'iec61966-2-1',
            '-tag:v', 'hvc1', mp4,
        ], input=raw, check=True)
        hvcc, samples = read_mp4(mp4)
    if len(samples) != len(frames):
        raise SystemExit(f'expected {len(frames)} samples, got {len(samples)}')
    out = {
        'note': 'Generated by scripts/make-apple-fixtures.py. Do not edit.',
        'tileSize': size,
        'colours': TILE_COLOURS,
        'alphaLevels': ALPHA_LEVELS,
        'nclx': {'primaries': 1, 'transfer': 13, 'matrix': 1, 'fullRange': True},
        'hvcC': base64.b64encode(hvcc).decode('ascii'),
        'tiles': [base64.b64encode(s).decode('ascii') for s in samples[:4]],
        'alphaTiles': [base64.b64encode(s).decode('ascii') for s in samples[4:]],
    }
    with open(os.path.join(OUT, 'hevc-tiles.json'), 'w') as f:
        json.dump(out, f, indent=1)
        f.write('\n')


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    make_p3()
    make_alpha()
    make_tiles()
    for name in sorted(os.listdir(OUT)):
        print(f'{name:18} {os.path.getsize(os.path.join(OUT, name)):7} bytes')
