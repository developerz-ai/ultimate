// The enforcement half of `scripts/fix-tails.ts`: this file IS the build error, because the gate's
// `unit` step runs every `scripts/**/*.test.ts`. The tree is asserted non-vacuously: a scan that
// read nothing is the answer a clean tree gives.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { fixTailFindings, fixTailProblem, fixTailSites } from './fix-tails';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

// A walk of every shipped source file: the repo-scan backstop, as every whole-tree test.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

describe('fixTailProblem', () => {
  test.each([
    ['edit a.ts, then: x verify'],
    ['edit a.ts, then x verify --json'],
    ['edit a.ts   # then x test'],
    ['edit a.ts, then: x test   # all of it'],
  ])('%s runs everything', (fix) => {
    expect(fixTailProblem(fix)).toBe('whole-run');
  });

  test.each([['see=x verify --only lint'], ['[x db migrate]']])(
    '%s keeps a citation the renderer cannot reach',
    (fix) => {
      expect(fixTailProblem(fix)).toBe('bare');
    },
  );

  test.each([
    ['edit a.ts, then: x verify --only boundaries'],
    ['edit a.ts, then x test unit --filter a.ts'],
    ['x verify --json   # the finding names the file'],
    ['edit a.ts, then x db migrate'],
    ['git commit -m "before x upgrade"'],
    ['bun run x -- verify'],
    ['bunx x doctor'],
  ])('%s is fine', (fix) => {
    expect(fixTailProblem(fix)).toBeUndefined();
  });
});

describe('the tree', () => {
  test('every fix line, shipped guards included, ends runnable and narrow', async () => {
    const sites = await fixTailSites(repoRoot());
    expect(sites.length).toBeGreaterThan(1000);
    expect(sites.some((site) => site.at === 'guards/raw-colour.ts')).toBe(true);
    expect(fixTailFindings(sites)).toEqual([]);
  });
});
