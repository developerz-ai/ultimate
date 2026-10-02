// Single responsibility: which media type an ISO base media file is. Every MP4, MOV, M4A, HEIC
// and AVIF opens with the same `ftyp` box, so the box alone says "container" — the four-byte MAJOR
// BRAND after it is what says which one, and reading only the box labelled all of them `video/mp4`.

const ascii = (bytes: Uint8Array, offset: number): string =>
  String.fromCharCode(...bytes.subarray(offset, offset + 4));

/** The type a major brand cannot narrow: a container, as `application/zip` is one for OOXML. */
export const ISO_BMFF_CONTAINER = 'video/mp4';

/** HEIF's structural brands — a still HEIC and a still AVIF both ship under `mif1`. */
export const HEIF_CONTAINER = 'image/heif';

// A `Map`, never an object literal: the brand is four bytes off an upload, and `BRANDS['cons']`
// is harmless only until a brand spells a prototype key.
const BRANDS: ReadonlyMap<string, string> = new Map([
  ['avif', 'image/avif'],
  ['avis', 'image/avif'],
  ['heic', 'image/heic'],
  ['heix', 'image/heic'],
  ['heim', 'image/heic'],
  ['heis', 'image/heic'],
  ['hevc', 'image/heic'],
  ['hevx', 'image/heic'],
  ['mif1', HEIF_CONTAINER],
  ['msf1', HEIF_CONTAINER],
  ['qt  ', 'video/quicktime'],
  ['M4A ', 'audio/mp4'],
  ['M4B ', 'audio/mp4'],
  ['M4P ', 'audio/mp4'],
  ['3gp4', 'video/3gpp'],
  ['3gp5', 'video/3gpp'],
  ['3gp6', 'video/3gpp'],
  ['3g2a', 'video/3gpp2'],
]);

/** Every type `sniffIsoBmff` can answer — what `validateUpload` reads "could confirm" from. */
export const ISO_BMFF_TYPES: readonly string[] = [
  ...new Set([ISO_BMFF_CONTAINER, ...BRANDS.values()]),
];

/**
 * `undefined` when the bytes do not open with a `ftyp` box carrying a brand. A brand this table
 * does not list answers the container: it is an ISO base media file, which is all the box proves,
 * and that is the answer every brand got before this file existed.
 */
export function sniffIsoBmff(bytes: Uint8Array): string | undefined {
  if (bytes.byteLength < 12 || ascii(bytes, 4) !== 'ftyp') return undefined;
  return BRANDS.get(ascii(bytes, 8)) ?? ISO_BMFF_CONTAINER;
}
