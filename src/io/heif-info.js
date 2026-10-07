/**
 * What a HEIF file says about itself, read without decoding a pixel.
 *
 * A small ISOBMFF reader: enough to tell a HEIC from an AVIF (they share the
 * container) and to find the colour information attached to the primary image.
 * It has no imports on purpose — the colour engine needs it to find a HEIC's
 * embedded profile, and the HEIC decoder needs the colour engine, so this is the
 * leaf both can stand on.
 *
 * Every length it follows is checked against the buffer: this runs in a
 * file-open handler, on bytes from anywhere.
 */

/** Brands that can only mean an HEVC-coded HEIF. */
const HEVC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx']);
/** Generic brands that AVIF uses too — they need a second look. */
const GENERIC_BRANDS = new Set(['mif1', 'msf1']);
const AVIF_BRANDS = new Set(['avif', 'avis']);

const fourcc = (b, at) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);

/**
 * Whether these bytes are an HEVC-coded HEIF.
 *
 * AVIF lives in the same container, often under the same generic `mif1` brand,
 * and every current browser decodes it natively — so it is told apart and left
 * to the browser rather than sent through a decoder that cannot read AV1.
 *
 * @param {Uint8Array|ArrayBuffer} bytes at least the first few dozen bytes
 */
export function isHEIF(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
  if (b.length < 16 || fourcc(b, 4) !== 'ftyp') return false;
  const size = Math.min(readU32(b, 0), b.length);
  if (size < 16) return false;
  const major = fourcc(b, 8);
  if (HEVC_BRANDS.has(major)) return true;
  const compatible = [];
  for (let at = 16; at + 4 <= size; at += 4) compatible.push(fourcc(b, at));
  if (compatible.some((c) => AVIF_BRANDS.has(c)) || AVIF_BRANDS.has(major)) return false;
  return GENERIC_BRANDS.has(major) || compatible.some((c) => HEVC_BRANDS.has(c));
}

function readU32(b, at) {
  return ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
}

function readU16(b, at) {
  return (b[at] << 8) | b[at + 1];
}

/**
 * The boxes directly inside [start, end), as {type, start, end} where `start` is
 * the first byte of the payload. A box that claims to run past `end` ends the
 * walk instead of being followed.
 */
function boxesIn(b, start, end) {
  const out = [];
  let at = start;
  while (at + 8 <= end) {
    let size = readU32(b, at);
    const type = fourcc(b, at + 4);
    let head = 8;
    if (size === 1) {
      if (at + 16 > end) break;
      // A 64-bit size. Anything past 2^32 is far beyond any buffer we hold.
      if (readU32(b, at + 8) !== 0) break;
      size = readU32(b, at + 12);
      head = 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (size < head || at + size > end) break;
    out.push({ type, start: at + head, end: at + size });
    at += size;
  }
  return out;
}

const childOf = (b, box, type) => boxesIn(b, box.start, box.end).find((x) => x.type === type) || null;

/**
 * The colour information attached to the primary image.
 *
 * A file can carry several `colr` properties — a thumbnail and the photo may
 * differ — so the one that counts is found through `pitm` and `ipma`, not by
 * taking the first in the file. The first is still the fallback for a file that
 * does not associate one, which is better than ignoring a profile that is there.
 *
 * @returns {{icc?:Uint8Array, nclx?:{primaries:number, transfer:number, matrix:number, fullRange:boolean}}|null}
 */
export function heifColour(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
  try {
    if (!isHEIF(b)) return null;
    const meta = boxesIn(b, 0, b.length).find((x) => x.type === 'meta');
    if (!meta) return null;
    // `meta` is a full box: four bytes of version and flags before its children.
    const inner = { start: meta.start + 4, end: meta.end };
    const iprp = childOf(b, inner, 'iprp');
    const ipco = iprp && childOf(b, iprp, 'ipco');
    if (!ipco) return null;
    const props = boxesIn(b, ipco.start, ipco.end);

    let colr = null;
    const pitm = childOf(b, inner, 'pitm');
    const ipma = childOf(b, iprp, 'ipma');
    if (pitm && ipma) {
      const primary = b[pitm.start] === 0 ? readU16(b, pitm.start + 4) : readU32(b, pitm.start + 4);
      for (const index of propertiesOf(b, ipma, primary)) {
        const prop = props[index - 1];
        if (prop && prop.type === 'colr') { colr = prop; break; }
      }
    }
    if (!colr) colr = props.find((p) => p.type === 'colr') || null;
    return colr ? readColr(b, colr) : null;
  } catch (err) {
    return null;
  }
}

/** The 1-based property indices `ipma` associates with one item. */
function propertiesOf(b, ipma, itemId) {
  const version = b[ipma.start];
  const wide = (b[ipma.start + 3] & 1) === 1;
  let at = ipma.start + 4;
  if (at + 4 > ipma.end) return [];
  const count = readU32(b, at);
  at += 4;
  for (let i = 0; i < count && at < ipma.end; i++) {
    const id = version < 1 ? readU16(b, at) : readU32(b, at);
    at += version < 1 ? 2 : 4;
    const n = b[at++];
    const indices = [];
    for (let k = 0; k < n && at < ipma.end; k++) {
      if (wide) { indices.push(readU16(b, at) & 0x7fff); at += 2; } else { indices.push(b[at] & 0x7f); at += 1; }
    }
    if (id === itemId) return indices;
  }
  return [];
}

function readColr(b, colr) {
  if (colr.end - colr.start < 4) return null;
  const kind = fourcc(b, colr.start);
  if (kind === 'prof' || kind === 'rICC') return { icc: b.slice(colr.start + 4, colr.end) };
  if (kind === 'nclx' && colr.end - colr.start >= 11) {
    return {
      nclx: {
        primaries: readU16(b, colr.start + 4),
        transfer: readU16(b, colr.start + 6),
        matrix: readU16(b, colr.start + 8),
        fullRange: (b[colr.start + 10] & 0x80) !== 0,
      },
    };
  }
  return null;
}
