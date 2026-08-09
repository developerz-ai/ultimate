// Single responsibility: identify an image and read its intrinsic pixel size from the header
// bytes alone — never a decode, never a guess from a file extension. WebP, AVIF, GIF and SVG
// have no built-in codec here, yet every `<img>` still needs `width`/`height` inlined, and
// that is the only thing that keeps CLS at 0 for them.

import { imageDecodeFailed, imageUnsupported } from './errors';
import { assertPixelBudget, type ImageSize } from './raster';

export const IMAGE_FORMATS = ['png', 'jpeg', 'webp', 'avif', 'gif', 'svg'] as const;
export type ImageFormat = (typeof IMAGE_FORMATS)[number];

export const IMAGE_MIME_TYPES: Readonly<Record<ImageFormat, string>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
  svg: 'image/svg+xml',
};

export interface ImageInfo {
  readonly format: ImageFormat;
  readonly width: number;
  readonly height: number;
  readonly mimeType: string;
}

/** `noUncheckedIndexedAccess` makes every index a `number | undefined`; -1 matches no byte. */
const byteAt = (bytes: Uint8Array, at: number): number => bytes[at] ?? -1;

const viewOf = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

const ascii = (bytes: Uint8Array, at: number, text: string): boolean => {
  if (at < 0 || at + text.length > bytes.length) return false;
  for (let i = 0; i < text.length; i += 1) {
    if (byteAt(bytes, at + i) !== text.charCodeAt(i)) return false;
  }
  return true;
};

const fourcc = (bytes: Uint8Array, at: number): string =>
  at + 4 > bytes.length
    ? ''
    : String.fromCharCode(
        byteAt(bytes, at),
        byteAt(bytes, at + 1),
        byteAt(bytes, at + 2),
        byteAt(bytes, at + 3),
      );

/** A truncated header is a decode failure with a name, never a silently returned 0x0. */
function requireBytes(bytes: Uint8Array, needed: number, format: string, missing: string): void {
  if (bytes.length < needed) {
    throw imageDecodeFailed(
      `${format} header is truncated: ${bytes.length} bytes, but ${missing} needs ${needed}`,
      { format, length: bytes.length, needed },
    );
  }
}

// ---------------------------------------------------------------------------- sniffing

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** `mif1` is the generic HEIF brand AVIF files carry; `avis` is an image sequence. */
const AVIF_BRANDS: ReadonlySet<string> = new Set(['avif', 'avis', 'mif1']);

function isAvif(bytes: Uint8Array): boolean {
  if (!ascii(bytes, 4, 'ftyp')) return false;
  if (AVIF_BRANDS.has(fourcc(bytes, 8))) return true;
  const declared = bytes.length >= 4 ? viewOf(bytes).getUint32(0) : 0;
  const end = Math.min(bytes.length, declared >= 16 ? declared : bytes.length);
  for (let at = 16; at + 4 <= end; at += 4) {
    if (AVIF_BRANDS.has(fourcc(bytes, at))) return true;
  }
  return false;
}

/** Whitespace and a UTF-8 BOM may precede an SVG document; nothing else may. */
const SVG_LEADING_BYTES: ReadonlySet<number> = new Set([0x20, 0x09, 0x0a, 0x0d, 0xef, 0xbb, 0xbf]);

/** Cheap gate: refusing binary here is what stops a 64KB text decode per non-image sniff. */
function opensWithTag(bytes: Uint8Array): boolean {
  for (let at = 0; at < bytes.length && at < 64; at += 1) {
    const byte = byteAt(bytes, at);
    if (byte === 0x3c) return true;
    if (!SVG_LEADING_BYTES.has(byte)) return false;
  }
  return false;
}

/**
 * Magic-byte sniff only. `null` when nothing matches — a file extension is a claim, not
 * evidence, and an agent that trusts one ships a `.png` that is really a WebP.
 */
export function sniffImageFormat(bytes: Uint8Array): ImageFormat | null {
  if (PNG_SIGNATURE.every((byte, at) => byteAt(bytes, at) === byte)) return 'png';
  if (byteAt(bytes, 0) === 0xff && byteAt(bytes, 1) === 0xd8 && byteAt(bytes, 2) === 0xff) {
    return 'jpeg';
  }
  if (ascii(bytes, 0, 'GIF87a') || ascii(bytes, 0, 'GIF89a')) return 'gif';
  if (ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')) return 'webp';
  if (isAvif(bytes)) return 'avif';
  if (opensWithTag(bytes) && svgRootIndex(svgHead(bytes)) >= 0) return 'svg';
  return null;
}

// ---------------------------------------------------------------------------- per format

/** Signature (8) + chunk length (4) + `IHDR` (4) + width (4) + height (4). */
function probePng(bytes: Uint8Array): ImageSize {
  requireBytes(bytes, 24, 'PNG', 'the signature plus the IHDR width and height');
  if (!ascii(bytes, 12, 'IHDR')) {
    throw imageDecodeFailed(
      `PNG's first chunk is "${fourcc(bytes, 12)}", but IHDR must come first`,
      {
        format: 'png',
        chunk: fourcc(bytes, 12),
      },
    );
  }
  const view = viewOf(bytes);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** SOF0..SOF15 minus DHT (C4), JPG (C8) and DAC (CC), which share the range but not the shape. */
const isSofMarker = (marker: number): boolean =>
  marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

/** Stand-alone markers carry no length word: TEM and the eight restart markers. */
const isStandaloneMarker = (marker: number): boolean =>
  marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);

/**
 * Walks segment lengths to the first SOF. Baseline, progressive and lossless all declare their
 * size the same way — probing is not decoding, so a format the decoder refuses still measures.
 */
function probeJpeg(bytes: Uint8Array): ImageSize {
  const view = viewOf(bytes);
  let at = 2;
  while (at + 3 < bytes.length) {
    if (byteAt(bytes, at) !== 0xff) {
      throw imageDecodeFailed(`JPEG marker walk desynchronised at byte ${at}, expected 0xFF`, {
        format: 'jpeg',
        offset: at,
      });
    }
    let marker = byteAt(bytes, at + 1);
    // Any number of 0xFF fill bytes may pad the gap before a marker code.
    while (marker === 0xff) {
      at += 1;
      marker = byteAt(bytes, at + 1);
    }
    if (isStandaloneMarker(marker) || marker === 0xd8) {
      at += 2;
      continue;
    }
    // Past SOS the bytes are entropy-coded, not segments: walking on would only desynchronise.
    if (marker === 0xda || marker === 0xd9) break;
    if (at + 3 >= bytes.length) break;
    const length = view.getUint16(at + 2);
    if (isSofMarker(marker)) {
      requireBytes(bytes, at + 9, 'JPEG', 'the SOF segment width and height');
      return { width: view.getUint16(at + 7), height: view.getUint16(at + 5) };
    }
    if (length < 2) {
      throw imageDecodeFailed(`JPEG segment 0xFF${marker.toString(16)} declares length ${length}`, {
        format: 'jpeg',
        offset: at,
        length,
      });
    }
    at += 2 + length;
  }
  throw imageDecodeFailed(
    `JPEG ends after ${bytes.length} bytes with no SOF marker, so it declares no size`,
    { format: 'jpeg', offset: at },
  );
}

/** Header (6) + logical screen width and height, little-endian. */
function probeGif(bytes: Uint8Array): ImageSize {
  requireBytes(bytes, 10, 'GIF', 'the logical screen width and height');
  const view = viewOf(bytes);
  return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
}

/** The lossy bitstream: a 3-byte frame tag, the start code, then 14-bit dimensions. */
function probeVp8(bytes: Uint8Array, data: number): ImageSize {
  const end = Math.min(bytes.length - 3, data + 32);
  for (let at = data; at <= end; at += 1) {
    if (byteAt(bytes, at) !== 0x9d) continue;
    if (byteAt(bytes, at + 1) !== 0x01 || byteAt(bytes, at + 2) !== 0x2a) continue;
    // The start code can sit in the last bytes of a truncated file; a DataView read past the
    // end raises a bare RangeError, which is exactly the un-coded failure the contract forbids.
    requireBytes(bytes, at + 7, 'WebP', 'the VP8 frame width and height');
    const view = viewOf(bytes);
    return {
      width: view.getUint16(at + 3, true) & 0x3fff,
      height: view.getUint16(at + 5, true) & 0x3fff,
    };
  }
  throw imageDecodeFailed('WebP VP8 chunk has no 9D 01 2A start code within its first 32 bytes', {
    format: 'webp',
    chunk: 'VP8 ',
  });
}

/** Lossless: a 0x2F signature byte, then 14-bit width-1 and height-1 packed little-endian. */
function probeVp8l(bytes: Uint8Array, data: number): ImageSize {
  requireBytes(bytes, data + 5, 'WebP', 'the VP8L signature and packed dimensions');
  if (byteAt(bytes, data) !== 0x2f) {
    throw imageDecodeFailed('WebP VP8L chunk does not start with its 0x2F signature byte', {
      format: 'webp',
      chunk: 'VP8L',
    });
  }
  const bits = viewOf(bytes).getUint32(data + 1, true);
  return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
}

/** Extended: flags (4), then 24-bit little-endian canvas width-1 and height-1. */
function probeVp8x(bytes: Uint8Array, data: number): ImageSize {
  requireBytes(bytes, data + 10, 'WebP', 'the VP8X canvas width and height');
  const read24 = (at: number): number =>
    byteAt(bytes, at) | (byteAt(bytes, at + 1) << 8) | (byteAt(bytes, at + 2) << 16);
  return { width: read24(data + 4) + 1, height: read24(data + 7) + 1 };
}

function probeWebp(bytes: Uint8Array): ImageSize {
  requireBytes(bytes, 20, 'WebP', 'the RIFF header and the first chunk header');
  const chunk = fourcc(bytes, 12);
  const data = 20;
  if (chunk === 'VP8 ') return probeVp8(bytes, data);
  if (chunk === 'VP8L') return probeVp8l(bytes, data);
  if (chunk === 'VP8X') return probeVp8x(bytes, data);
  throw imageDecodeFailed(`WebP's first chunk is "${chunk}", not VP8 , VP8L or VP8X`, {
    format: 'webp',
    chunk,
  });
}

/**
 * `ispe` lives in the `meta` box, which always precedes the pixel data — scanning further
 * would only ever match a false positive inside `mdat`. The first one is the primary item's.
 */
const AVIF_SCAN_BYTES = 65_536;

function probeAvif(bytes: Uint8Array): ImageSize {
  const end = Math.min(bytes.length, AVIF_SCAN_BYTES);
  for (let at = 0; at + 16 <= end; at += 1) {
    if (!ascii(bytes, at, 'ispe')) continue;
    const view = viewOf(bytes);
    return { width: view.getUint32(at + 8), height: view.getUint32(at + 12) };
  }
  throw imageDecodeFailed('AVIF carries no `ispe` property box, so it declares no intrinsic size', {
    format: 'avif',
    scanned: end,
  });
}

// ---------------------------------------------------------------------------- svg

/** Only the prologue and the root tag carry the box; an SVG body can be megabytes. */
const SVG_HEAD_BYTES = 65_536;
/** `TextDecoder` already strips a leading BOM, so only real whitespace is left to skip. */
const SVG_WHITESPACE = ' \t\n\r\f\v';
const SVG_PIXELS = /^\s*(\d*\.?\d+)(?:px)?\s*$/i;

const svgHead = (bytes: Uint8Array): string =>
  new TextDecoder().decode(bytes.subarray(0, SVG_HEAD_BYTES));

/** The only things allowed before the root element: a comment, an XML declaration, a DOCTYPE. */
const SVG_PROLOGUE: readonly (readonly [string, string])[] = [
  ['<!--', '-->'],
  ['<?', '?>'],
  ['<!', '>'],
];

/**
 * Index of the root `<svg`, or -1. Hand-walked rather than matched with a regex: the input is
 * untrusted, and an alternation of lazy groups backtracks catastrophically on a near-miss.
 */
function svgRootIndex(text: string): number {
  let at = 0;
  while (at < text.length) {
    if (SVG_WHITESPACE.includes(text[at] ?? '')) {
      at += 1;
      continue;
    }
    if (text.startsWith('<svg', at)) return at;
    const prologue = SVG_PROLOGUE.find(([open]) => text.startsWith(open, at));
    if (prologue === undefined) return -1;
    const close = text.indexOf(prologue[1], at);
    at = close === -1 ? text.length : close + prologue[1].length;
  }
  return -1;
}

const svgAttribute = (tag: string, name: string): string | undefined =>
  new RegExp(`\\s${name}\\s*=\\s*['"]([^'"]*)['"]`, 'i').exec(tag)?.[1];

/** A percentage is a share of a viewport, not a pixel size — it cannot reserve a box. */
function svgPixels(value: string | undefined): number | null {
  if (value === undefined) return null;
  const matched = SVG_PIXELS.exec(value);
  const pixels = Number(matched?.[1] ?? Number.NaN);
  return Number.isFinite(pixels) && pixels > 0 ? Math.round(pixels) : null;
}

function svgViewBox(tag: string): ImageSize | null {
  const raw = svgAttribute(tag, 'viewBox');
  if (raw === undefined) return null;
  const parts = raw.trim().split(/[\s,]+/);
  const width = Math.round(Number(parts[2] ?? ''));
  const height = Math.round(Number(parts[3] ?? ''));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return null;
  return { width, height };
}

function probeSvg(bytes: Uint8Array): ImageSize {
  const text = svgHead(bytes);
  const start = svgRootIndex(text);
  const closing = text.indexOf('>', start);
  const tag = text.slice(start, closing === -1 ? text.length : closing + 1);
  const width = svgPixels(svgAttribute(tag, 'width'));
  const height = svgPixels(svgAttribute(tag, 'height'));
  if (width !== null && height !== null) return { width, height };
  const viewBox = svgViewBox(tag);
  if (viewBox !== null) return viewBox;
  throw imageDecodeFailed(
    'SVG declares no intrinsic size: its root tag carries no pixel `width` and `height`, and ' +
      'no usable `viewBox`',
    { format: 'svg' },
  );
}

// ---------------------------------------------------------------------------- entry point

function probeSize(bytes: Uint8Array, format: ImageFormat): ImageSize {
  switch (format) {
    case 'png':
      return probePng(bytes);
    case 'jpeg':
      return probeJpeg(bytes);
    case 'gif':
      return probeGif(bytes);
    case 'webp':
      return probeWebp(bytes);
    case 'avif':
      return probeAvif(bytes);
    case 'svg':
      return probeSvg(bytes);
  }
}

/**
 * Format + intrinsic pixel dimensions, read from the header. Never decodes — this is what
 * lets `<img>` carry `width`/`height` for formats no built-in codec can read.
 */
export function probeImage(bytes: Uint8Array): ImageInfo {
  const format = sniffImageFormat(bytes);
  if (format === null) {
    throw imageUnsupported(
      `the first bytes match no image format this pipeline knows (${bytes.length} bytes read)`,
      `re-encode the source as one of ${IMAGE_FORMATS.join(', ')} — \`file <path>\` names what ` +
        'it actually is',
      { length: bytes.length },
    );
  }
  const { width, height } = probeSize(bytes, format);
  // Before any allocation downstream: a hostile header is refused here, not at malloc.
  assertPixelBudget(width, height, format);
  return { format, width, height, mimeType: IMAGE_MIME_TYPES[format] };
}
