// The shared size/tone/variant vocabulary every component's props draw from — pinned so a
// component can't silently accept a rung this file doesn't declare, and every scale stays
// duplicate-free (a repeated rung is always a copy-paste mistake, never intentional).

import { describe, expect, test } from 'bun:test';
import { BUTTON_VARIANTS, SIZES, TONES } from './variants';

function assertUniqueNonEmpty(values: readonly string[]) {
  expect(values.length).toBeGreaterThan(0);
  expect(new Set(values).size).toBe(values.length);
  expect(values.every((v) => v.length > 0)).toBe(true);
}

describe('SIZES', () => {
  test('is a non-empty, duplicate-free scale', () => {
    assertUniqueNonEmpty(SIZES);
  });

  test('is the documented one size scale', () => {
    expect(SIZES).toEqual(['sm', 'md', 'lg']);
  });
});

describe('TONES', () => {
  test('is a non-empty, duplicate-free scale', () => {
    assertUniqueNonEmpty(TONES);
  });

  test('maps 1:1 onto the documented status colour roles', () => {
    expect(TONES).toEqual(['neutral', 'accent', 'success', 'warning', 'danger', 'info']);
  });
});

describe('TONES <-> $tones', () => {
  test('the SCSS tone list that generates .tone-* classes matches TONES exactly', async () => {
    const source = await Bun.file(
      new URL('../tokens/_colors.scss', import.meta.url).pathname,
    ).text();
    const list = /\$tones:\s*\(([^)]*)\)/.exec(source);
    expect(list?.[1]).toBeDefined();
    const scss = (list?.[1] ?? '').split(',').map((entry) => entry.trim());
    expect(scss).toEqual([...TONES]);
  });
});

describe('BUTTON_VARIANTS', () => {
  test('is a non-empty, duplicate-free scale', () => {
    assertUniqueNonEmpty(BUTTON_VARIANTS);
  });

  test('is the documented set of button variants', () => {
    expect(BUTTON_VARIANTS).toEqual(['primary', 'secondary', 'ghost', 'link']);
  });
});
