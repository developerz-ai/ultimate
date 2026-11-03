// `budgetsFreshness` decides whether `x verify`'s budgets step may read the stats on disk or has to
// build first. Each state is one row; the equal-mtime row is the one a coarse filesystem clock hits.

import { describe, expect, test } from 'bun:test';
import type { BuildStats } from './budgets';
import { BUILD_STATS_RULES } from './budgets';
import { budgetsFreshness } from './budgets-freshness';

const current: BuildStats = { routes: [], measuredBy: BUILD_STATS_RULES };
const oldRule: BuildStats = { routes: [], stale: true };

describe('unit · budgetsFreshness', () => {
  test('no stats file is missing, whatever the sources say', () => {
    expect(budgetsFreshness({ stats: undefined, statsMtimeMs: 0, newestSourceMtimeMs: 5 })).toBe(
      'missing',
    );
    expect(budgetsFreshness({ stats: undefined, statsMtimeMs: undefined })).toBe('missing');
  });

  test('a file an earlier measurement rule wrote is old-rule, even when newer than the source', () => {
    expect(budgetsFreshness({ stats: oldRule, statsMtimeMs: 9, newestSourceMtimeMs: 1 })).toBe(
      'old-rule',
    );
  });

  test('a source edited after the stats were written is older-than-source', () => {
    expect(budgetsFreshness({ stats: current, statsMtimeMs: 10, newestSourceMtimeMs: 11 })).toBe(
      'older-than-source',
    );
  });

  test('stats written after every source are fresh', () => {
    expect(budgetsFreshness({ stats: current, statsMtimeMs: 12, newestSourceMtimeMs: 11 })).toBe(
      'fresh',
    );
  });

  test('equal mtimes are fresh: the build ran in the same clock tick as the last edit', () => {
    expect(budgetsFreshness({ stats: current, statsMtimeMs: 11, newestSourceMtimeMs: 11 })).toBe(
      'fresh',
    );
  });

  test('an app with no source file at all reads its stats as fresh', () => {
    expect(budgetsFreshness({ stats: current, statsMtimeMs: 11 })).toBe('fresh');
  });

  test('a stats file whose mtime could not be read is not trusted', () => {
    expect(
      budgetsFreshness({ stats: current, statsMtimeMs: undefined, newestSourceMtimeMs: 1 }),
    ).toBe('missing');
  });

  // A save landing while the build ran is older than the stats file and newer than what the build
  // read: the stats carry the newest source mtime read before the build began, and that decides.
  test('a source saved during the build is older-than-source, though older than the stats file', () => {
    const during: BuildStats = { ...current, sourcesAt: 10 };
    expect(budgetsFreshness({ stats: during, statsMtimeMs: 20, newestSourceMtimeMs: 15 })).toBe(
      'older-than-source',
    );
    expect(budgetsFreshness({ stats: during, statsMtimeMs: 20, newestSourceMtimeMs: 10 })).toBe(
      'fresh',
    );
  });
});
