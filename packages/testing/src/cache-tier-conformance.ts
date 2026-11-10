// The `CacheTier` contract as shared examples: `behavesLike(cacheTierConformance, () => tier)` runs
// every check against a tier of your own, one test per check, each inside a request — the memo tier
// holds nothing outside one, and every other tier must not care which side it is called from.

import { test } from 'bun:test';
import type { CacheTier } from '@ultimat3/cache';
import { ctxOf, runWithContext } from '@ultimat3/core';
import { CACHE_TIER_CHECKS } from './cache-tier-conformance-checks';
import type { SharedExamples } from './shared-examples';
import { sharedExamples } from './shared-examples';

export type { CacheTierCheck } from './cache-tier-conformance-checks';
export { CACHE_TIER_CHECKS } from './cache-tier-conformance-checks';

export const cacheTierConformance: SharedExamples<CacheTier | Promise<CacheTier>> = sharedExamples(
  'a cache tier',
  (subject) => {
    for (const check of CACHE_TIER_CHECKS) {
      test(check.name, async () => {
        await runWithContext(ctxOf(), async () => check.run(await subject()));
      });
    }
  },
);
