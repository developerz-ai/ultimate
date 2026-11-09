// The split's rules: refused bounds, a value outside them refused, keys mirrored under rtl, and a
// pointer read from the inline start.

import { describe, expect, test } from 'bun:test';
import { PANE_KEY_STEP, paneBounds, paneKey, panePercentAt, paneValue } from './split-pane-view';

const bounds = paneBounds(20, 80);

const codeOf = (run: () => unknown): string | undefined => {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return expect.unreachable('the call was accepted');
};

describe('bounds and values', () => {
  test('min over max, and a bound outside 0..100, are X_UI_INVALID_VALUE', () => {
    expect(codeOf(() => paneBounds(60, 40))).toBe('X_UI_INVALID_VALUE');
    expect(codeOf(() => paneBounds(-1, 50))).toBe('X_UI_INVALID_VALUE');
    expect(codeOf(() => paneBounds(0, Number.NaN))).toBe('X_UI_INVALID_VALUE');
  });

  test('a value outside the bounds is refused, never clamped away', () => {
    expect(codeOf(() => paneValue(90, bounds))).toBe('X_UI_INVALID_VALUE');
    expect(paneValue(50, bounds)).toBe(50);
  });
});

describe('paneKey', () => {
  test('ArrowRight grows the start pane in ltr and shrinks it in rtl', () => {
    expect(paneKey('ArrowRight', 50, bounds, 'ltr')).toBe(50 + PANE_KEY_STEP);
    expect(paneKey('ArrowRight', 50, bounds, 'rtl')).toBe(50 - PANE_KEY_STEP);
    expect(paneKey('ArrowLeft', 50, bounds, 'rtl')).toBe(50 + PANE_KEY_STEP);
  });

  test('Home and End go to the bounds; a step past one clamps', () => {
    expect(paneKey('Home', 50, bounds, 'ltr')).toBe(20);
    expect(paneKey('End', 50, bounds, 'ltr')).toBe(80);
    expect(paneKey('ArrowRight', 78, bounds, 'ltr')).toBe(80);
    expect(paneKey('Enter', 50, bounds, 'ltr')).toBeNull();
  });
});

describe('panePercentAt', () => {
  const box = { start: 100, size: 400 };
  test('measures from the left in ltr and from the right in rtl', () => {
    expect(panePercentAt(300, box, paneBounds(), 'ltr')).toBe(50);
    expect(panePercentAt(200, box, paneBounds(), 'ltr')).toBe(25);
    expect(panePercentAt(200, box, paneBounds(), 'rtl')).toBe(75);
  });

  test('clamps to the bounds and survives a zero-width box', () => {
    expect(panePercentAt(0, box, bounds, 'ltr')).toBe(20);
    expect(panePercentAt(5, { start: 0, size: 0 }, bounds, 'ltr')).toBe(20);
  });
});
