// The live tests' process-tree walk: one bounded `ps` listing, walked in memory, so a cleanup in a
// `finally` waits at most one timeout however deep the tree it reaps.

import { describe, expect, test } from 'bun:test';
import { descendantsIn, descendantsOf } from './dev-live-fixture';

describe('descendantsIn', () => {
  test('every descendant, depth first, from one pid → ppid listing', () => {
    const listing = [
      [10, 1],
      [11, 10],
      [12, 11],
      [13, 10],
      [20, 1],
    ] as const;
    expect(descendantsIn(listing, 10)).toEqual([11, 12, 13]);
    expect(descendantsIn(listing, 20)).toEqual([]);
  });

  test('a cycle in a racing listing cannot walk forever', () => {
    expect(
      descendantsIn(
        [
          [2, 3],
          [3, 2],
        ],
        2,
      ),
    ).toEqual([3]);
  });
});

describe('descendantsOf', () => {
  test('finds a real child and grandchild of a running process', async () => {
    const root = Bun.spawn(['sh', '-c', '(sleep 30 & wait) & wait'], { stdout: 'ignore' });
    try {
      let found: readonly number[] = [];
      for (let attempt = 0; attempt < 40 && found.length < 2; attempt += 1) {
        await Bun.sleep(25);
        found = descendantsOf(root.pid);
      }
      expect(found.length).toBeGreaterThanOrEqual(2);
    } finally {
      // Asked BEFORE the root dies: afterwards its children are init's and no walk reaches them.
      for (const pid of [...descendantsOf(root.pid), root.pid]) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already gone — the outcome wanted.
        }
      }
    }
  });
});
