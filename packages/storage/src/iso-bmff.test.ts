import { describe, expect, test } from 'bun:test';
import { isStorageError } from './errors';
import { sniffIsoBmff } from './iso-bmff';
import { contentTypeMatches, sniffContentType, uploadPolicy, validateUpload } from './upload';

const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));

/** A `ftyp` box: size, `ftyp`, major brand, minor version, then the compatible brands. */
function ftyp(major: string, compatible: readonly string[] = []): Uint8Array {
  const size = 16 + compatible.length * 4;
  return new Uint8Array([
    0,
    0,
    0,
    size,
    ...ascii('ftyp'),
    ...ascii(major),
    0,
    0,
    0,
    0,
    ...compatible.flatMap(ascii),
    ...new Array<number>(32).fill(0x01),
  ]);
}

function outcome(declared: string, bytes: Uint8Array, allowed: readonly string[]): string {
  try {
    return validateUpload(
      { key: 'org/o1/pending/u-1', declaredContentType: declared, bytes },
      uploadPolicy({ allowedContentTypes: allowed }),
    ).contentType;
  } catch (error) {
    return isStorageError(error) ? `${error.code}: ${error.cause}` : `uncoded: ${String(error)}`;
  }
}

describe('the ISO-BMFF major brand decides the type', () => {
  // One `ftyp` rule labelled every ISO-BMFF file `video/mp4`, so an AVIF under a policy that
  // allowed `image/avif` was refused as "magic bytes are video/mp4" — HEIC, MOV and M4A the same.
  test.each([
    ['avif', 'image/avif'],
    ['avis', 'image/avif'],
    ['heic', 'image/heic'],
    ['heix', 'image/heic'],
    ['mif1', 'image/heif'],
    ['qt  ', 'video/quicktime'],
    ['M4A ', 'audio/mp4'],
    ['M4B ', 'audio/mp4'],
    ['M4V ', 'video/mp4'],
    ['isom', 'video/mp4'],
    ['mp42', 'video/mp4'],
    ['3gp4', 'video/3gpp'],
  ])('brand %p sniffs as %s', (brand, type) => {
    expect(sniffContentType(ftyp(brand))).toBe(type);
  });

  test('a brand nobody lists is still the container it was before', () => {
    expect(sniffContentType(ftyp('zzzz'))).toBe('video/mp4');
  });

  test('a box too short to carry a brand is not an ISO-BMFF file', () => {
    expect(sniffIsoBmff(new Uint8Array([0, 0, 0, 8, ...ascii('ftyp')]))).toBeUndefined();
    expect(sniffIsoBmff(new Uint8Array([0, 0, 0, 16, ...ascii('free'), ...ascii('avif')]))).toBe(
      undefined,
    );
  });
});

describe('validateUpload accepts each ISO-BMFF type the policy allows', () => {
  test.each([
    ['image/avif', 'avif'],
    ['image/heic', 'heic'],
    ['video/quicktime', 'qt  '],
    ['audio/mp4', 'M4A '],
    ['video/mp4', 'isom'],
  ])('%s', (type, brand) => {
    expect(outcome(type, ftyp(brand), [type])).toBe(type);
  });

  test('the names a browser gives an .m4a and an .m4v are the same types', () => {
    expect(outcome('audio/x-m4a', ftyp('M4A '), ['audio/mp4'])).toBe('audio/mp4');
    expect(outcome('audio/x-m4a', ftyp('M4A '), ['audio/x-m4a'])).toBe('audio/mp4');
    expect(outcome('video/x-m4v', ftyp('M4V '), ['video/mp4'])).toBe('video/mp4');
  });

  test('a generic container stands in for the type it may hold, and for nothing else', () => {
    // `mif1` is HEIF's structural brand — an iPhone HEIC and a still AVIF both ship under it — and
    // an audio-only MP4 written by ffmpeg carries `isom`. Neither brand can say more.
    expect(outcome('image/heic', ftyp('mif1', ['heic']), ['image/heic'])).toBe('image/heic');
    expect(outcome('image/avif', ftyp('mif1', ['avif']), ['image/avif'])).toBe('image/avif');
    expect(outcome('audio/mp4', ftyp('isom'), ['audio/mp4'])).toBe('audio/mp4');
    expect(contentTypeMatches('image/png', 'image/heif')).toBe(false);
    expect(contentTypeMatches('image/avif', 'video/mp4')).toBe(false);
  });

  test('a brand that contradicts the declared type is still refused', () => {
    expect(outcome('image/avif', ftyp('isom'), ['image/avif'])).toContain(
      'X_STORAGE_TYPE_REJECTED',
    );
    expect(outcome('image/avif', ftyp('heic'), ['image/avif'])).toContain(
      'X_STORAGE_TYPE_REJECTED',
    );
    expect(outcome('video/mp4', ftyp('avif'), ['video/mp4'])).toContain('X_STORAGE_TYPE_REJECTED');
  });

  test('an unrecognisable body under an ISO-BMFF type is refused, not trusted', () => {
    const garbage = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09]);
    for (const type of ['image/avif', 'image/heic', 'video/quicktime', 'audio/mp4', 'video/mp4']) {
      expect(outcome(type, garbage, [type])).toContain('match no known signature');
    }
  });
});
