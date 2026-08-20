// Single responsibility: proves the pipeline's three failure modes carry a registered title and
// a fix a caller can act on. A code that is not in `CORE_CODE_TITLES` still renders — as the
// humanised fallback — so only a test can tell "registered" from "silently degraded".

import { describe, expect, test } from 'bun:test';
import { type CoreErrorCode, describeErrorCode, hasErrorCode } from '../error-codes';
import { UltimateError } from '../errors';
import {
  ImageDecodeFailedError,
  ImageTooLargeError,
  ImageUnsupportedError,
  imageDecodeFailed,
  imageFromBunError,
  imageTooLarge,
  imageUnsupported,
} from './errors';

// `CoreErrorCode[]`, not `as const`: a mutable array is the shape `test.each` takes, and the
// annotation makes a code that leaves `CORE_CODE_TITLES` a compile error here rather than a
// runtime `hasErrorCode` failure.
const CODES: CoreErrorCode[] = [
  'X_IMAGE_UNSUPPORTED',
  'X_IMAGE_DECODE_FAILED',
  'X_IMAGE_TOO_LARGE',
];

describe('registration', () => {
  test.each(CODES)('%s is registered, not humanised at render time', (code) => {
    expect(hasErrorCode(code)).toBe(true);
    // `humanize()` would give 'image unsupported'; a registered title says more than the code.
    expect(describeErrorCode(code).title).not.toBe(
      code.replace('X_', '').toLowerCase().replaceAll('_', ' '),
    );
  });

  test.each(CODES)('%s has a docs URL', (code) => {
    expect(describeErrorCode(code).docs).toBe(`https://ultimate.dev/errors/${code}`);
  });
});

describe('imageUnsupported', () => {
  test('is an UltimateError carrying the caller-supplied cause and fix', () => {
    const error = imageUnsupported('decoding avif is not built in', 'request png or jpeg');
    expect(error).toBeInstanceOf(UltimateError);
    expect(error).toBeInstanceOf(ImageUnsupportedError);
    expect(error.code).toBe('X_IMAGE_UNSUPPORTED');
    expect(error.cause).toBe('decoding avif is not built in');
    expect(error.fix).toBe('request png or jpeg');
  });

  test('keeps the meta so a caller can branch on the format without parsing prose', () => {
    expect(imageUnsupported('nope', 'fix it', { format: 'avif' }).meta).toEqual({ format: 'avif' });
  });

  test('names itself, so a stack trace is readable', () => {
    expect(imageUnsupported('nope', 'fix it').name).toBe('ImageUnsupportedError');
  });
});

describe('imageDecodeFailed', () => {
  test('supplies its own fix — the caller never has to invent one', () => {
    const error = imageDecodeFailed('png IDAT ends 40 bytes early');
    expect(error).toBeInstanceOf(ImageDecodeFailedError);
    expect(error.code).toBe('X_IMAGE_DECODE_FAILED');
    expect(error.fix).toContain('file <path>');
  });

  test('carries meta through', () => {
    expect(imageDecodeFailed('truncated', { length: 30 }).meta).toEqual({ length: 30 });
  });
});

describe('imageTooLarge', () => {
  test('points at the ceiling by name, so raising it is a deliberate act', () => {
    const error = imageTooLarge('80000000 pixels, over the ceiling');
    expect(error).toBeInstanceOf(ImageTooLargeError);
    expect(error.code).toBe('X_IMAGE_TOO_LARGE');
    expect(error.fix).toContain('MAX_IMAGE_PIXELS');
  });
});

describe('every image error', () => {
  test('renders the three-line form with a runnable fix, never a bare message', () => {
    const rendered = imageUnsupported(
      'encoding webp is not built in',
      'request png or jpeg',
    ).toJSON();
    expect(rendered).toMatchObject({
      code: 'X_IMAGE_UNSUPPORTED',
      title: 'the built-in image pipeline cannot read or write this format',
      cause: 'encoding webp is not built in',
      fix: 'request png or jpeg',
      docs: 'https://ultimate.dev/errors/X_IMAGE_UNSUPPORTED',
    });
  });
});

describe('imageFromBunError', () => {
  /** The shape `Bun.Image` rejects with: a plain Error carrying a stable `code`. */
  const bunError = (code: string): unknown => Object.assign(new Error(`Image: ${code}`), { code });

  test.each([
    ['ERR_IMAGE_FORMAT_UNSUPPORTED', 'X_IMAGE_UNSUPPORTED'],
    ['ERR_IMAGE_UNKNOWN_FORMAT', 'X_IMAGE_UNSUPPORTED'],
    ['ERR_IMAGE_TOO_MANY_PIXELS', 'X_IMAGE_TOO_LARGE'],
    ['ERR_IMAGE_DECODE_FAILED', 'X_IMAGE_DECODE_FAILED'],
    ['ERR_IMAGE_ENCODE_FAILED', 'X_IMAGE_DECODE_FAILED'],
    ['ERR_INVALID_STATE', 'X_IMAGE_DECODE_FAILED'],
  ])('maps %s onto %s', (bunCode, code) => {
    const error = imageFromBunError(bunError(bunCode), 'transforming the image');
    expect(error.code).toBe(code);
    expect(error.meta).toMatchObject({ bunCode });
    expect(error.cause).toContain('transforming the image');
  });

  test('the format refusal names the three portable formats and the way to the others', () => {
    const error = imageFromBunError(bunError('ERR_IMAGE_FORMAT_UNSUPPORTED'), 'encoding');
    expect(error.fix).toContain('webp');
    expect(error.fix).toContain('ImageTransformDriver');
  });

  test('a code nobody mapped is still a coded error, never a bare one', () => {
    // A syscall code (ENOENT, EACCES) reaches this for a file-backed input.
    const error = imageFromBunError(
      Object.assign(new Error('boom'), { code: 'ENOENT' }),
      'reading',
    );
    expect(error.code).toBe('X_IMAGE_DECODE_FAILED');
    expect(error).toBeInstanceOf(ImageDecodeFailedError);
  });

  test('a value that fights being read still renders, and does not throw doing it', () => {
    // A rejection crossing a worker arrives as a plain object, and reading `.code` off one is a
    // getter call on a value the framework did not build. `new Error` here is INPUT, never a
    // verdict — the assertions below are what report.
    const fights = new Error('this value fights being read');
    const hostile = new Proxy(
      {},
      {
        get() {
          throw fights;
        },
      },
    );
    const error = imageFromBunError(hostile, 'transforming the image');
    expect(error.code).toBe('X_IMAGE_DECODE_FAILED');
    expect(error.cause).toContain('transforming the image');
  });
});
