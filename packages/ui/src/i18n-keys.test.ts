// UI_KEYS is the one namespace every built-in string in the design system resolves through —
// a duplicate or malformed key silently collides with (or falls outside) the `ui.*` catalog
// namespace an app merges in, so its shape is worth pinning directly.

import { describe, expect, test } from 'bun:test';
import { FRAMEWORK_CATALOG } from '@ultimat3/i18n';
import { UI_KEYS } from './i18n-keys';

/**
 * Both halves of the `ui.*` contract, here rather than in the repo's catalog gate, because this is
 * the only place the answer is EXACT. Every built-in string resolves as `ui.t(UI_KEYS.x)` — a
 * member call on a variable, which the framework's static extractor cannot follow — so the gate
 * sees `ui.*` through string literals and can only prove reachability, never that a key resolves.
 * One declared table against one catalog proves both directions with no scan at all.
 */
describe('UI_KEYS against the framework catalog', () => {
  test('every key the design system resolves has an entry — a miss renders ⟦key⟧', () => {
    const missing = Object.values(UI_KEYS).filter((key) => !Object.hasOwn(FRAMEWORK_CATALOG, key));
    expect(missing).toEqual([]);
  });

  test('every ui.* entry is one this table names — a catalog key nothing resolves is dead', () => {
    const declared = new Set<string>(Object.values(UI_KEYS));
    const orphans = Object.keys(FRAMEWORK_CATALOG).filter(
      (key) => key.startsWith('ui.') && !declared.has(key),
    );
    expect(orphans).toEqual([]);
  });
});

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
