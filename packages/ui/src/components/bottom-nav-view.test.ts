import { describe, expect, test } from 'bun:test';
import { UI_ERROR_CODES } from '../errors';
import { BOTTOM_NAV_MAX, bottomNavItems } from './bottom-nav-view';

describe('bottomNavItems', () => {
  test('five pass through; six are X_UI_INVALID_VALUE naming the count', () => {
    const five = Array.from({ length: BOTTOM_NAV_MAX }, (_, i) => i);
    expect(bottomNavItems(five)).toBe(five);
    try {
      bottomNavItems([...five, 5]);
    } catch (error) {
      expect((error as { code?: unknown }).code).toBe(UI_ERROR_CODES.invalidValue);
      expect(String((error as { cause?: unknown }).cause)).toContain('6 items');
      return;
    }
    expect.unreachable('six destinations were accepted');
  });
});
