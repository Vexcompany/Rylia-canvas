import { suite } from '../harness.js';
import { createCanvas } from '/src/core/util.js';
import { openFile } from '/src/io/open.js';
import { decodeImage } from '/src/io/decode.js';
import { exportDocument } from '/src/io/save.js';
import { isHEIF, heifColour } from '/src/io/heif-info.js';
import { decodeHEIF } from '/src/io/heif-read.js';
import { muxHEIF, toI420, tileSizeFor, quantizerFor, heicEncodeSupport } from '/src/io/heif-write.js';
import { isICNS, icnsEntries, readICNS, writeICNS, unpackIconRLE } from '/src/io/icns.js';
import { getProfile, profileOf, transformImageData } from '/src/color/icc.js';

/**
 * HEIC and ICNS — the two Apple formats.
 *
 * The HEIC fixtures in tests/fixtures/ come from real encoders (libheif + x265,
 * and ffmpeg's libx265), made by scripts/make-apple-fixtures.py. They have to:
 * headless Chromium on Linux has no HEVC encoder, so nothing in this suite can
 * make a HEIC from scratch, and a muxer tested only against itself would prove
 * nothing. What it can do is assemble a file from tiles a real encoder produced
 * and hand it to a real decoder.
 */

const fixture = async (name) => new Uint8Array(await (await fetch(`/tests/fixtures/${name}`)).arrayBuffer());
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function rgbaAt(canvas, x, y) {
  return Array.from(canvas.getContext('2d', { willReadFrequently: true }).getImageData(x, y, 1, 1).data);
}

function within(actual, expected, tol) {
  return expected.every((v, i) => Math.abs(actual[i] - v) <= tol);
}

/** An `ftyp` box and nothing else. */
function ftyp(major, compatible = []) {
  const brands = [major, '\0\0\0\0', ...compatible].join('');
  const size = 8 + brands.length;
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, size);
  out.set(Uint8Array.from('ftyp' + brands, (c) => c.charCodeAt(0)), 4);
  return out;
}

suite('apple formats / HEIC is told apart from AVIF by its brands', async (t) => {
  t.ok(isHEIF(ftyp('heic', ['mif1', 'heic'])), 'an iPhone ftyp is HEIC');
  t.ok(isHEIF(ftyp('mif1', ['heic'])), 'generic mif1 with a heic brand is HEIC');
  t.ok(isHEIF(ftyp('msf1', ['hevc'])), 'an HEVC image sequence is HEIC');
  t.ok(isHEIF(ftyp('heix', [])), 'a 10-bit heix is HEIC');
  t.notOk(isHEIF(ftyp('avif', ['mif1', 'miaf'])), 'AVIF is left to the browser');
  t.notOk(isHEIF(ftyp('mif1', ['avif'])), 'AVIF under the generic brand is still AVIF');
  t.notOk(isHEIF(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1)), 'a JPEG is not HEIC');
  t.notOk(isHEIF(ftyp('heic').subarray(0, 10)), 'a truncated header is not HEIC, and does not throw');
  t.notOk(isHEIF(new Uint8Array(0)), 'nothing at all is not HEIC');
  t.eq(heifColour(new Uint8Array(64)), null, 'garbage has no colour information, and does not throw');
});

suite('apple formats / an iPhone-style HEIC opens as sRGB, exactly as the same JPEG does', async (t) => {
  const bytes = await fixture('p3.heic');
  // Patch 3 is (200, 120, 60) in Display P3. In sRGB that is a more saturated
  // orange; left unconverted it would open dull.
  const expected = new ImageData(1, 1);
  expected.data.set([200, 120, 60, 255]);
  transformImageData(expected, getProfile('display-p3'), getProfile('srgb'));
  const want = Array.from(expected.data);

  // The type a Chrome file picker reports for a .heic: nothing.
  const doc = await openFile(new File([bytes], 'IMG_0001.HEIC', { type: '' }));
  try {
    t.eq([doc.width, doc.height], [64, 48], 'opens at its own size');
    t.eq(doc.name, 'IMG_0001', 'named after the file');
    t.eq(profileOf(doc).id, 'srgb', 'the document is sRGB, because its pixels were converted into sRGB');
    t.eq(doc.sourceProfileName, 'Display P3', 'and it remembers the profile the file came with');

    const got = rgbaAt(doc.layers[0].canvas, 40, 24);
    t.ok(within(got, want, 3), `P3 orange converted to sRGB: got ${got}, want ${want}`);
    t.gt(got[0] - 200, 8, 'and visibly not the unconverted P3 numbers');
    t.ok(within(rgbaAt(doc.layers[0].canvas, 56, 24), [128, 128, 128, 255], 2), 'neutral grey stays neutral');
    t.eq(doc.dirty, false, 'a freshly opened HEIC is not dirty');
  } finally {
    t.app.closeDocument(doc);
  }

  // The same picture as a JPEG, carrying the same profile. The browser converts
  // that one; heif-read.js converts the HEIC. They must agree.
  const jpeg = await openFile(new File([await fixture('p3.jpg')], 'IMG_0001.JPG', { type: 'image/jpeg' }));
  try {
    const fromJpeg = rgbaAt(jpeg.layers[0].canvas, 40, 24);
    t.ok(within(fromJpeg, want, 3), `the JPEG of the same photo opens with the same colour: ${fromJpeg}`);
    t.eq([profileOf(jpeg).id, jpeg.sourceProfileName], ['srgb', 'Display P3'], 'and is described the same way');
  } finally {
    t.app.closeDocument(jpeg);
  }

  const renamed = await openFile(new File([bytes], 'renamed.jpg', { type: 'image/jpeg' }));
  try {
    t.eq([renamed.width, renamed.height], [64, 48], 'a HEIC called .jpg still opens — the bytes decide, not the name');
  } finally {
    t.app.closeDocument(renamed);
  }
});

suite('apple formats / HEIC transparency survives', async (t) => {
  const canvas = await decodeImage(new Blob([await fixture('alpha.heic')]));
  t.eq([canvas.width, canvas.height], [32, 32], 'opens at its own size');
  t.ok(within(rgbaAt(canvas, 8, 16), [30, 120, 220, 255], 3), 'the opaque half is opaque');
  t.close(rgbaAt(canvas, 24, 16)[3], 64, 2, 'the translucent half keeps its alpha');
});

suite('apple formats / a muxed HEIC grid decodes in a real decoder', async (t) => {
  const fx = await (await fetch('/tests/fixtures/hevc-tiles.json')).json();
  const parts = {
    hvcC: b64(fx.hvcC),
    tiles: fx.tiles.map(b64),
    alphaTiles: fx.alphaTiles.map(b64),
    tileW: fx.tileSize, tileH: fx.tileSize, cols: 2, rows: 2,
    // Smaller than the 128x128 the tiles cover: the grid must crop.
    width: 100, height: 90,
    nclx: fx.nclx,
  };
  const bytes = muxHEIF(parts);
  t.ok(isHEIF(bytes), 'the output sniffs as HEIC');
  t.eq(heifColour(bytes), { nclx: fx.nclx }, 'the nclx colour property reads back from the primary item');

  const canvas = await decodeHEIF(bytes);
  t.eq([canvas.width, canvas.height], [100, 90], 'the grid is cropped to the image size, not the tile size');
  const centres = [[20, 20], [84, 20], [20, 80], [84, 80]];
  centres.forEach(([x, y], i) => {
    const got = rgbaAt(canvas, x, y);
    t.close(got[3], fx.alphaLevels[i], 1, `tile ${i + 1} carries its alpha (${fx.alphaLevels[i]})`);
    if (fx.alphaLevels[i] === 255) {
      t.ok(within(got, [...fx.colours[i], 255], 3), `tile ${i + 1} is in the right place and the right colour: ${got}`);
    }
  });

  const opaque = await decodeHEIF(muxHEIF({ ...parts, alphaTiles: null, width: 128, height: 128 }));
  t.eq(rgbaAt(opaque, 127, 127)[3], 255, 'without an alpha grid the image is opaque');
  t.ok(within(rgbaAt(opaque, 100, 100), [...fx.colours[3], 255], 3), 'and the last tile lands bottom-right');

  await t.throws(() => muxHEIF({ ...parts, tiles: parts.tiles.slice(1) }), 'a missing tile is refused, not written');
});

suite('apple formats / the HEIC encoder converts colour the way it declares', async (t) => {
  const image = new ImageData(2, 2);
  image.data.set([255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255]);
  t.eq(Array.from(toI420(image)), [76, 76, 76, 76, 85, 255], 'pure red is full-range BT.601 (76, 85, 255)');
  image.data.set([255, 255, 255, 40, 255, 255, 255, 40, 255, 255, 255, 40, 255, 255, 255, 40]);
  t.eq(Array.from(toI420(image)), [255, 255, 255, 255, 128, 128], 'white is (255, 128, 128) whatever its alpha');
  t.eq(Array.from(toI420(image, true)), [40, 40, 40, 40, 128, 128], 'an alpha plane is the alpha as luma, chroma neutral');

  t.eq(tileSizeFor(4032, 3024), { tileW: 512, tileH: 512 }, 'a photo is cut into 512 px tiles, as an iPhone does');
  t.eq(tileSizeFor(100, 90), { tileW: 112, tileH: 96 }, 'a small image is one tile, rounded up to 16');
  t.eq(tileSizeFor(8, 8), { tileW: 64, tileH: 64 }, 'and never below what an encoder accepts');

  t.eq([quantizerFor(1), quantizerFor(0)], [0, 51], 'quality spans the whole quantizer range');
  t.ok(quantizerFor(0.9) < quantizerFor(0.8) && quantizerFor(0.8) < quantizerFor(0.5), 'more quality is a finer quantizer');
});

suite('apple formats / HEIC export works, or says why it cannot', async (t) => {
  const support = await heicEncodeSupport();
  const doc = t.doc(40, 30, '#2060c0');
  if (!support.ok) {
    t.ok(/HEVC/.test(support.reason), `the reason names what is missing: "${support.reason}"`);
    t.eq(await exportDocument(doc, { format: 'heic', save: false }), null, 'exporting reports failure instead of writing a mislabelled file');
  } else {
    const blob = await exportDocument(doc, { format: 'heic', save: false, quality: 0.9 });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    t.ok(isHEIF(bytes), 'the export is a HEIC');
    const back = await decodeHEIF(bytes);
    t.eq([back.width, back.height], [40, 30], 'at the document size');
    t.ok(within(rgbaAt(back, 20, 15), [0x20, 0x60, 0xc0, 255], 4), 'with the document colour');
  }

  // The dialog shows the format either way, and disables it with the reason
  // where it cannot work.
  const { showExportDialog } = await import('/src/ui/dialogs/export.js');
  const pending = showExportDialog(doc);
  await new Promise((r) => setTimeout(r, 50));
  const option = document.querySelector('.pkd-export option[value="heic"]');
  t.ok(option, 'Export As lists HEIC');
  t.eq(option && option.disabled, !support.ok, 'and enables it exactly when this browser can encode it');
  t.ok(document.querySelector('.pkd-export option[value="icns"]'), 'Export As lists ICNS');
  const close = document.querySelector('.pkd-export .pk-dialog-close');
  if (close) close.click();
  await pending;
});

/** A 100 px source with four coloured quadrants. */
function quadrants(size) {
  const c = createCanvas(size, size);
  const g = c.getContext('2d');
  const h = size / 2;
  [['#ff0000', 0, 0], ['#00ff00', h, 0], ['#0000ff', 0, h], ['#ffffff', h, h]].forEach(([fill, x, y]) => {
    g.fillStyle = fill;
    g.fillRect(x, y, h, h);
  });
  return c;
}

suite('apple formats / ICNS round-trips, and never upscales', async (t) => {
  const blob = await writeICNS(quadrants(100));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  t.ok(isICNS(bytes), 'the output is an ICNS');
  t.eq(new DataView(bytes.buffer).getUint32(4), bytes.length, 'the header length is the file length');

  const entries = icnsEntries(bytes);
  t.eq(entries.map((e) => e.type), ['icp4', 'ic11', 'icp5', 'icp6', 'ic12'], 'a 100 px source gets every slot up to 64 px, and none above');
  const pngSize = (d) => new DataView(d.buffer, d.byteOffset).getUint32(16);
  t.eq(entries.map((e) => pngSize(e.data)), [16, 32, 32, 64, 64], 'each PNG is the size its slot promises');

  const back = await readICNS(bytes);
  t.eq([back.width, back.height], [64, 64], 'reading picks the largest entry');
  t.ok(within(rgbaAt(back, 16, 16), [255, 0, 0, 255], 2), 'top-left is red');
  t.ok(within(rgbaAt(back, 48, 48), [255, 255, 255, 255], 2), 'bottom-right is white');

  const big = icnsEntries(new Uint8Array(await (await writeICNS(quadrants(1024))).arrayBuffer()));
  t.eq(big.length, 11, 'a 1024 px source fills every slot');
  t.ok(big.some((e) => e.type === 'ic10'), 'including the 1024 px Retina one');

  const doc = await openFile(new File([bytes], 'App.icns', { type: '' }));
  try {
    t.eq([doc.width, doc.height, doc.name], [64, 64, 'App'], 'File > Open takes an .icns');
    const exported = await exportDocument(doc, { format: 'icns', save: false });
    t.ok(exported && isICNS(new Uint8Array(await exported.arrayBuffer())), 'and Export As writes one');
  } finally {
    t.app.closeDocument(doc);
  }
});

suite('apple formats / pre-Lion RLE icons still open', async (t) => {
  // An is32 (16x16 RGB, Apple's RLE) and its s8mk mask, built by hand.
  const red = [0xff, 200, 251, 200];                       // 130 + 126 repeats of 200
  const green = [3, 10, 20, 30, 40, 0xff, 50, 247, 50];   // 4 literals, then 130 + 122 of 50
  const blue = [0xff, 0, 251, 0];
  const rgb = Uint8Array.from([...red, ...green, ...blue]);
  const mask = new Uint8Array(256).fill(255);
  mask.fill(0, 240);                                       // last row transparent

  const entry = (type, data) => {
    const out = new Uint8Array(8 + data.length);
    out.set(Uint8Array.from(type, (c) => c.charCodeAt(0)));
    new DataView(out.buffer).setUint32(4, out.length);
    out.set(data, 8);
    return out;
  };
  const body = [entry('is32', rgb), entry('s8mk', mask)];
  const total = 8 + body.reduce((n, b) => n + b.length, 0);
  const file = new Uint8Array(total);
  file.set(Uint8Array.from('icns', (c) => c.charCodeAt(0)));
  new DataView(file.buffer).setUint32(4, total);
  let at = 8;
  for (const b of body) { file.set(b, at); at += b.length; }

  const canvas = await readICNS(file);
  t.eq([canvas.width, canvas.height], [16, 16], 'decodes at 16 px');
  t.pixel(canvas, 1, 0, '200,20,0,255', 'a literal run lands where it belongs');
  t.pixel(canvas, 8, 7, '200,50,0,255', 'a repeated run fills the plane');
  t.eq(rgbaAt(canvas, 8, 15)[3], 0, 'the mask makes the last row transparent');

  await t.throws(() => unpackIconRLE(Uint8Array.of(0xff, 1), 0, new Uint8Array(16), 16), 'a run past the plane is refused');
  await t.throws(() => readICNS(file.subarray(0, 20)), 'a truncated icon fails cleanly');
  await t.throws(() => readICNS(new Uint8Array(32)), 'something that is not an icon fails cleanly');
});
