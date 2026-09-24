// Single responsibility: the EXIF orientation tag (0x0112) of one JPEG APP1 segment. The decoder
// applies it — `Bun.Image` reports a 40x20 sensor image tagged `6` as 20x40 — so a probe that
// ignored it reserved a layout box with width and height swapped.

const EXIF_HEADER = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"
const ORIENTATION_TAG = 0x0112;
const SHORT = 3;

/**
 * The orientation (1–8) an APP1 payload declares, or `1` when it declares none or cannot be read.
 * Never throws: EXIF is metadata beside the image, and a malformed block is one the decoder
 * ignores too — refusing the whole image over it would fail a file every browser renders.
 *
 * `payload` is the segment body after its length word.
 */
export function exifOrientation(payload: Uint8Array): number {
  if (payload.length < EXIF_HEADER.length + 8) return 1;
  if (EXIF_HEADER.some((byte, index) => payload[index] !== byte)) return 1;
  const tiff = payload.subarray(EXIF_HEADER.length);
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const order = view.getUint16(0);
  if (order !== 0x4949 && order !== 0x4d4d) return 1;
  const little = order === 0x4949;
  if (view.getUint16(2, little) !== 42) return 1;
  const ifd = view.getUint32(4, little);
  if (ifd + 2 > tiff.length) return 1;
  const entries = view.getUint16(ifd, little);
  for (let index = 0; index < entries; index += 1) {
    const at = ifd + 2 + index * 12;
    if (at + 12 > tiff.length) return 1;
    if (view.getUint16(at, little) !== ORIENTATION_TAG) continue;
    if (view.getUint16(at + 2, little) !== SHORT) return 1;
    const value = view.getUint16(at + 8, little);
    return value >= 1 && value <= 8 ? value : 1;
  }
  return 1;
}

/** Orientations 5–8 transpose the image: the stored width is the displayed height. */
export const swapsAxes = (orientation: number): boolean => orientation >= 5 && orientation <= 8;
