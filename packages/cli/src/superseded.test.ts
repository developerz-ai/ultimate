import { describe, expect, test } from 'bun:test';
import { SUPERSEDED_WORKAROUNDS } from './superseded';

describe('unit · the superseded-workaround table', () => {
  test('ids are unique and kebab-case: a CHANGELOG line names one', () => {
    const ids = SUPERSEDED_WORKAROUNDS.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });

  test('every row names the release that shipped its replacement', () => {
    for (const row of SUPERSEDED_WORKAROUNDS) expect(row.shippedIn).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('every row matches on comment text: at least one pattern, never a global flag', () => {
    for (const row of SUPERSEDED_WORKAROUNDS) {
      expect(row.pattern.comment.length).toBeGreaterThan(0);
      // `g` keeps `lastIndex` between `test` calls: the second file would miss the first's hit.
      for (const pattern of [...row.pattern.comment, row.pattern.near]) {
        expect(pattern?.global ?? false).toBe(false);
      }
    }
  });

  test('every fix opens with a command or code to paste', () => {
    for (const row of SUPERSEDED_WORKAROUNDS) {
      expect(row.fix).toMatch(/^(?:x [a-z]|[a-z]+: '|<[A-Z])/);
    }
  });
});
