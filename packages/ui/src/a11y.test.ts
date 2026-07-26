import { beforeEach, describe, expect, test } from 'bun:test';
import { ariaBool, FOCUSABLE_SELECTOR, nextRovingIndex, resetIdCounter, useId } from './a11y';

describe('useId', () => {
  beforeEach(resetIdCounter);

  test('is unique and prefixed for label wiring', () => {
    const a = useId('field');
    const b = useId('field');
    expect(a).not.toBe(b);
    expect(a.startsWith('field-')).toBe(true);
  });
});

describe('nextRovingIndex', () => {
  test('moves and wraps along the inline axis', () => {
    expect(nextRovingIndex(0, 'ArrowRight', 3)).toBe(1);
    expect(nextRovingIndex(2, 'ArrowRight', 3)).toBe(0);
    expect(nextRovingIndex(0, 'ArrowLeft', 3)).toBe(2);
  });

  test('inline arrows invert in RTL so the keyboard matches the visual order', () => {
    expect(nextRovingIndex(0, 'ArrowLeft', 3, { dir: 'rtl' })).toBe(1);
    expect(nextRovingIndex(1, 'ArrowRight', 3, { dir: 'rtl' })).toBe(0);
  });

  test('respects orientation', () => {
    expect(nextRovingIndex(0, 'ArrowDown', 3, { orientation: 'horizontal' })).toBe(0);
    expect(nextRovingIndex(0, 'ArrowDown', 3, { orientation: 'vertical' })).toBe(1);
    expect(nextRovingIndex(0, 'ArrowRight', 3, { orientation: 'vertical' })).toBe(0);
    expect(nextRovingIndex(0, 'ArrowRight', 3, { orientation: 'both' })).toBe(1);
  });

  test('Home and End jump to the ends; loop can be disabled', () => {
    expect(nextRovingIndex(1, 'Home', 4)).toBe(0);
    expect(nextRovingIndex(1, 'End', 4)).toBe(3);
    expect(nextRovingIndex(3, 'ArrowRight', 4, { loop: false })).toBe(3);
    expect(nextRovingIndex(0, 'ArrowLeft', 4, { loop: false })).toBe(0);
  });

  test('non-navigation keys and empty groups are inert', () => {
    expect(nextRovingIndex(2, 'a', 4)).toBe(2);
    expect(nextRovingIndex(0, 'ArrowRight', 0)).toBe(-1);
  });
});

describe('FOCUSABLE_SELECTOR', () => {
  test('excludes disabled controls and tabindex -1', () => {
    expect(FOCUSABLE_SELECTOR).toContain('button:not([disabled])');
    expect(FOCUSABLE_SELECTOR).toContain('[tabindex]:not([tabindex="-1"])');
    expect(FOCUSABLE_SELECTOR).not.toContain('button,');
  });
});

describe('ariaBool', () => {
  test('renders enumerated strings and keeps undefined as "omit the attribute"', () => {
    expect(ariaBool(true)).toBe('true');
    expect(ariaBool(false)).toBe('false');
    expect(ariaBool(undefined)).toBeUndefined();
  });
});
