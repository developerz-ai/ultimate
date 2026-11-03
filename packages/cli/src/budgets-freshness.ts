// Whether `x verify`'s budgets step may read the stats on disk, or has to build first. Pure: the
// stats as `readBuildStats` returned them and two mtimes in, one state out. The reads that gather
// the mtimes are `verify-budgets-build.ts`'s.

import type { BuildStats } from './budgets';

/** `fresh` is the only state the step reads without building first. */
export type BudgetsFreshness = 'fresh' | 'missing' | 'old-rule' | 'older-than-source';

export interface FreshnessInput {
  /** `readBuildStats`' answer: `undefined` is no file, `stale: true` a file of an earlier rule. */
  readonly stats: BuildStats | undefined;
  /** The stats file's mtime; `undefined` when it could not be read. */
  readonly statsMtimeMs: number | undefined;
  /** The newest mtime over the app's source set; `undefined` when the set is empty. */
  readonly newestSourceMtimeMs?: number | undefined;
}

/**
 * Mtimes, never a content hash: a wrong answer here costs one rebuild, never a wrong verdict, and
 * the rebuild writes the stats again. Equal mtimes are fresh, because a build finishing in the same
 * clock tick as the last save read that save. A stats file with no readable mtime is not trusted.
 */
export function budgetsFreshness(input: FreshnessInput): BudgetsFreshness {
  if (input.stats === undefined || input.statsMtimeMs === undefined) return 'missing';
  if (input.stats.stale === true) return 'old-rule';
  const newest = input.newestSourceMtimeMs;
  // What the build READ, when it said (`sourcesAt`): a save landing during the build is older than
  // the stats file and newer than that. A file an older build wrote has only its own mtime.
  const read = input.stats.sourcesAt ?? input.statsMtimeMs;
  return newest !== undefined && newest > read ? 'older-than-source' : 'fresh';
}
