// UI_KEYS is the one namespace every built-in string in the design system resolves through —
// a duplicate or malformed key silently collides with (or falls outside) the `ui.*` catalog
// namespace an app merges in, so its shape is worth pinning directly.

import { describe, expect, test } from 'bun:test';
import { UI_KEYS } from './i18n-keys';

describe('UI_KEYS', () => {
  test('every key lives under the ui.* namespace', () => {
    for (const value of Object.values(UI_KEYS)) {
      expect(value.startsWith('ui.')).toBe(true);
    }
  });

  test('every catalog value is unique — no two props resolve to the same string', () => {
    const values = Object.values(UI_KEYS);
    expect(new Set(values).size).toBe(values.length);
  });

  test('every property name is unique and non-empty', () => {
    const names = Object.keys(UI_KEYS);
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((name) => name.length > 0)).toBe(true);
  });
});
