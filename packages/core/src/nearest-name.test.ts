// The suggester three packages read: `@ultimat3/cli` for an unknown command, flag, type or
// declaration, `@ultimat3/policy` for an unknown permission. What is pinned here is what a caller's
// `fix:` line depends on — the cutoff, the tie-break, and that a far-away word suggests NOTHING.

import { describe, expect, test } from 'bun:test';
import { nearestName } from './nearest-name';

describe('unit · nearestName', () => {
  test('one transposition, one insertion and one deletion all resolve', () => {
    expect(nearestName('migarte', ['migrate', 'gen', 'reset'])).toBe('migrate');
    expect(nearestName('migratee', ['migrate', 'gen'])).toBe('migrate');
    expect(nearestName('migrat', ['migrate', 'gen'])).toBe('migrate');
    expect(nearestName('billing:wirte', ['billing:write', 'billing:read'])).toBe('billing:write');
  });

  test('an exact name answers itself, at distance zero', () => {
    expect(nearestName('migrate', ['gen', 'migrate', 'reset'])).toBe('migrate');
  });

  // The cutoff is the whole guarantee. Leading with a "suggestion" four edits away sends a reader
  // to a command that was never what they meant, and a wrong lead is worse than none — which is
  // why every caller has a second arm for `undefined` rather than a fallback name.
  test('nothing within three edits is undefined, never a distant word', () => {
    expect(nearestName('zzzz', ['migrate', 'gen'])).toBeUndefined();
    expect(nearestName('billing:write', ['orders:cancel'])).toBeUndefined();
    // Exactly at the cutoff and exactly past it: three edits answers, four does not.
    expect(nearestName('migr', ['migrate'])).toBe('migrate');
    expect(nearestName('mig', ['migrate'])).toBeUndefined();
  });

  test('an empty candidate list is undefined, not a throw', () => {
    expect(nearestName('migrate', [])).toBeUndefined();
  });

  // Ties keep the FIRST candidate, which is the order the caller declared them in — a
  // `definePermissions([...])` list and a `CommandSpec` list are both authored orders. Without the
  // strict `<` the answer would be the LAST equally-close name and no test could pin either.
  test('a tie keeps the first declared candidate', () => {
    expect(nearestName('cat', ['bat', 'hat', 'mat'])).toBe('bat');
    expect(nearestName('cat', ['mat', 'hat', 'bat'])).toBe('mat');
  });
});
