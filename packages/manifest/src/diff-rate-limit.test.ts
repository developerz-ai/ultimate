// How a declared rate limit moved when one side resolves it per call. A per-call limit is the
// app's function of the caller, so no static number proves a caller the old build served still is:
// a move to or from one is breaking, exactly as `diffMeter` judges a per-call meter.

import { describe, expect, test } from 'bun:test';
import { diffRateLimit } from './diff-rate-limit';
import type { ActionFact, RateLimitFact } from './schema';

const fact = (
  limit: { readonly fixed?: RateLimitFact; readonly perCall?: number } = {},
): ActionFact => ({
  name: 'createPost',
  input: {},
  output: {},
  policy: null,
  permissions: [],
  cacheInvalidates: [],
  mcp: { expose: false },
  ...(limit.fixed === undefined ? {} : { rateLimit: limit.fixed }),
  ...(limit.perCall === undefined ? {} : { rateLimitPerCall: { windowMs: limit.perCall } }),
});

const kinds = (before: ActionFact, after: ActionFact) =>
  diffRateLimit('actions.createPost', before, after).map((change) => [change.kind, change.path]);

const at = 'actions.createPost.rateLimit';
const fixed = { limit: 5, windowMs: 60_000 };

describe('diffRateLimit, per call', () => {
  test('introducing a per-call limit is breaking; removing one is additive', () => {
    expect(kinds(fact(), fact({ perCall: 60_000 }))).toEqual([['breaking', at]]);
    expect(kinds(fact({ perCall: 60_000 }), fact())).toEqual([['additive', at]]);
  });

  test('a move between a fixed pair and a per-call limit is breaking, both ways', () => {
    expect(kinds(fact({ fixed }), fact({ perCall: 60_000 }))).toEqual([['breaking', at]]);
    expect(kinds(fact({ perCall: 60_000 }), fact({ fixed }))).toEqual([['breaking', at]]);
  });

  // Taken as the same resolver over a moved window: a longer one refills slower.
  test('the same per-call limit is no change; a longer window breaking, a shorter additive', () => {
    expect(kinds(fact({ perCall: 60_000 }), fact({ perCall: 60_000 }))).toEqual([]);
    expect(kinds(fact({ perCall: 60_000 }), fact({ perCall: 120_000 }))).toEqual([
      ['breaking', at],
    ]);
    expect(kinds(fact({ perCall: 60_000 }), fact({ perCall: 1_000 }))).toEqual([['additive', at]]);
  });

  test('a file declaring both shapes, or a non-positive window, is not classified', () => {
    expect(kinds(fact({ fixed, perCall: 60_000 }), fact())).toEqual([]);
    expect(kinds(fact({ perCall: 0 }), fact({ fixed }))).toEqual([]);
  });
});
