// Single responsibility: proves the colour grammar accepts exactly four hex forms and one name,
// and that every rejection hands back the whole accepted set — a padding colour is the one place a
// caller guesses at syntax, so the error has to be the documentation.

import { describe, expect, test } from 'bun:test';
import { parseColor } from './color';
import { ImageUnsupportedError } from './errors';

const codeOf = (run: () => unknown): string => {
  try {
    run();
    return 'no-throw';
  } catch (error) {
    return error instanceof ImageUnsupportedError ? error.code : `unexpected: ${String(error)}`;
  }
};

const fixOf = (run: () => unknown): string => {
  try {
    run();
    return 'no-throw';
  } catch (error) {
    return error instanceof ImageUnsupportedError ? error.fix : `unexpected: ${String(error)}`;
  }
};

describe('parseColor', () => {
  test('transparent is the only name', () => {
    expect(parseColor('transparent')).toEqual([0, 0, 0, 0]);
    expect(codeOf(() => parseColor('red'))).toBe('X_IMAGE_UNSUPPORTED');
  });

  test('doubles the nibbles of the short forms', () => {
    expect(parseColor('#abc')).toEqual([0xaa, 0xbb, 0xcc, 255]);
    expect(parseColor('#abcd')).toEqual([0xaa, 0xbb, 0xcc, 0xdd]);
  });

  test('reads the long forms, defaulting alpha to opaque', () => {
    expect(parseColor('#aabbcc')).toEqual([0xaa, 0xbb, 0xcc, 255]);
    expect(parseColor('#aabbccdd')).toEqual([0xaa, 0xbb, 0xcc, 0xdd]);
  });

  test('is case insensitive', () => {
    expect(parseColor('#AABBCC')).toEqual(parseColor('#aabbcc'));
    expect(parseColor('#ABCD')).toEqual(parseColor('#abcd'));
    expect(parseColor('TRANSPARENT')).toEqual([0, 0, 0, 0]);
  });

  test('rejects a hex string of the wrong length', () => {
    expect(codeOf(() => parseColor('#12'))).toBe('X_IMAGE_UNSUPPORTED');
    expect(codeOf(() => parseColor('#1234567'))).toBe('X_IMAGE_UNSUPPORTED');
    expect(codeOf(() => parseColor('#gghhii'))).toBe('X_IMAGE_UNSUPPORTED');
    expect(codeOf(() => parseColor(''))).toBe('X_IMAGE_UNSUPPORTED');
  });

  test('names every accepted form in the fix', () => {
    const fix = fixOf(() => parseColor('rebeccapurple'));
    for (const form of ['#rgb', '#rgba', '#rrggbb', '#rrggbbaa', 'transparent']) {
      expect(fix).toContain(form);
    }
  });
});
