// How a declared meter moved, judged by one question: is a call pattern the old meter admitted now
// refused? Periods are UTC and nest (24 hours in a day, at most 31 days in a month), so a shorter
// period with the same allowance is LOOSER, never tighter.

import { describe, expect, test } from 'bun:test';
import { diffMeter } from './diff-meter';
import type { ActionFact, MeterFact } from './schema';

const fact = (meter?: Partial<MeterFact> | null): ActionFact => ({
  name: 'createPost',
  input: {},
  output: {},
  policy: null,
  permissions: [],
  cacheInvalidates: [],
  mcp: { expose: false },
  ...(meter === undefined || meter === null
    ? {}
    : {
        meter: {
          name: 'posts',
          period: 'day',
          timeZone: 'UTC',
          limit: 100,
          warnAt: null,
          ...meter,
        },
      }),
});

const kinds = (before: ActionFact, after: ActionFact) =>
  diffMeter('actions.createPost', before, after).map((change) => [change.kind, change.path]);

const at = 'actions.createPost.meter';

describe('diffMeter', () => {
  test('no meter on either side, or the same one, is no change', () => {
    expect(kinds(fact(), fact())).toEqual([]);
    expect(kinds(fact({}), fact({}))).toEqual([]);
  });

  test('introducing a meter is breaking; removing one is additive', () => {
    expect(kinds(fact(), fact({}))).toEqual([['breaking', at]]);
    expect(kinds(fact({}), fact())).toEqual([['additive', at]]);
  });

  test('a lower limit is breaking; a higher one additive', () => {
    expect(kinds(fact({ limit: 100 }), fact({ limit: 10 }))).toEqual([['breaking', at]]);
    expect(kinds(fact({ limit: 10 }), fact({ limit: 100 }))).toEqual([['additive', at]]);
  });

  test('a shorter period at the same allowance admits more, so it is additive', () => {
    // 100 a day admits 100 in one hour; 100 an hour admits that and 2,300 more.
    expect(kinds(fact({ period: 'day' }), fact({ period: 'hour' }))).toEqual([['additive', at]]);
    // ...but a shorter period with a smaller allowance refuses the 100-in-an-hour burst.
    expect(kinds(fact({ period: 'day' }), fact({ period: 'hour', limit: 99 }))).toEqual([
      ['breaking', at],
    ]);
  });

  test('a longer period is breaking unless it covers every shorter period at full use', () => {
    // 100 a day, every day of a 31-day month, is 3,100 calls the month must still admit.
    expect(kinds(fact({}), fact({ period: 'month', limit: 3_000 }))).toEqual([['breaking', at]]);
    expect(kinds(fact({}), fact({ period: 'month', limit: 3_099 }))).toEqual([['breaking', at]]);
    expect(kinds(fact({}), fact({ period: 'month', limit: 3_100 }))).toEqual([['additive', at]]);
    expect(kinds(fact({ period: 'hour', limit: 1 }), fact({ period: 'day', limit: 23 }))).toEqual([
      ['breaking', at],
    ]);
    expect(
      kinds(fact({ period: 'hour', limit: 1 }), fact({ period: 'month', limit: 744 })),
    ).toEqual([['additive', at]]);
  });

  test('a limit resolved per call cannot be compared to a number, so either move is breaking', () => {
    expect(kinds(fact({ limit: 100 }), fact({ limit: null }))).toEqual([['breaking', at]]);
    expect(kinds(fact({ limit: null }), fact({ limit: 100 }))).toEqual([['breaking', at]]);
  });

  test('two per-call limits are judged by the period alone, the resolver taken as unchanged', () => {
    expect(kinds(fact({ limit: null }), fact({ limit: null, period: 'month' }))).toEqual([
      ['breaking', at],
    ]);
    expect(kinds(fact({ limit: null }), fact({ limit: null, period: 'hour' }))).toEqual([
      ['additive', at],
    ]);
  });

  test("a renamed meter is breaking: the name rides the refusal's public meta", () => {
    expect(kinds(fact({}), fact({ name: 'drafts' }))).toEqual([['breaking', `${at}.name`]]);
  });

  test('warnAt is the app’s own signal: a change is internal', () => {
    expect(kinds(fact({ warnAt: 0.8 }), fact({ warnAt: 0.9 }))).toEqual([
      ['internal', `${at}.warnAt`],
    ]);
  });

  test('both sides refusing every call is the same contract whatever the period says', () => {
    expect(kinds(fact({ limit: 0 }), fact({ limit: 0, period: 'month' }))).toEqual([
      ['internal', at],
    ]);
  });

  test('a meter this reader cannot make sense of is not classified', () => {
    const nonsense = fact({});
    const broken = {
      ...nonsense,
      meter: { name: 'posts', period: 'week' },
    } as unknown as ActionFact;
    expect(kinds(broken, fact({ limit: 1 }))).toEqual([]);
    // Only UTC exists: a zone this reader does not know cuts periods it cannot compare.
    const zoned = fact({ timeZone: 'Europe/Paris' as 'UTC' });
    expect(kinds(zoned, fact({ limit: 1 }))).toEqual([]);
    const negative = fact({ limit: -1 });
    expect(kinds(negative, fact({ limit: 1 }))).toEqual([]);
  });
});
