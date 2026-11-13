// The route-load and empty-reach warnings: a loop in a load is reported with the route's file, a
// load the pass could not run says why, a clean one says nothing, and a primitive reached with no
// statement and no effect is named once.

import { describe, expect, test } from 'bun:test';
import type { ExerciseRecord, RouteLoadRecord } from '@ultimat3/testing';
import { emptyReachWarnings, routeLoadWarnings } from './exercise-routes';

const route = (over: Partial<RouteLoadRecord>): RouteLoadRecord => ({
  kind: 'route',
  name: '/messages',
  file: 'apps/web/app/messages/page.tsx',
  outcome: 'reached',
  statements: 4,
  effects: [],
  ms: 1,
  ...over,
});

const primitive = (name: string, over: Partial<ExerciseRecord> = {}): ExerciseRecord => ({
  kind: 'query',
  name,
  outcome: 'reached',
  statements: 0,
  effects: [],
  ms: 1,
  ...over,
});

describe('unit · routeLoadWarnings', () => {
  test("a loop in a route load is reported with the route's file and the shape that grew", () => {
    const [line, ...rest] = routeLoadWarnings([
      route({
        scale: {
          verdict: 'grows',
          shapes: [{ fingerprint: 'participants.findMany', small: 2, large: 8 }],
          expected: [],
        },
      }),
    ]);
    expect(rest).toEqual([]);
    expect(line).toContain('route /messages (apps/web/app/messages/page.tsx)');
    expect(line).toContain('X_QUERY_SCALES_WITH_ROWS participants.findMany 2→8');
  });

  test('a load over the ceiling names its busiest shapes', () => {
    const [line] = routeLoadWarnings([
      route({
        statementCeiling: {
          verdict: 'over',
          statements: 140,
          max: 100,
          top: [{ fingerprint: 'users.findById', count: 120 }],
        },
      }),
    ]);
    expect(line).toContain('X_STATEMENTS_OVER_BUDGET 140 statements in one load, max 100');
    expect(line).toContain('users.findById ×120');
  });

  test('a load the pass could not run says why; a flat one within the ceiling says nothing', () => {
    expect(
      routeLoadWarnings([route({ outcome: 'unreached', reason: ':slug names no key' })]),
    ).toEqual([
      'route /messages (apps/web/app/messages/page.tsx) · load not exercised: :slug names no key',
    ]);
    expect(
      routeLoadWarnings([
        route({
          scale: { verdict: 'flat', expected: [] },
          statementCeiling: { verdict: 'within', statements: 4, max: 100 },
        }),
      ]),
    ).toEqual([]);
  });
});

describe('unit · emptyReachWarnings', () => {
  test('reached with no statement and no effect is named; one with either is not', () => {
    const [line, ...rest] = emptyReachWarnings([
      primitive('health'),
      primitive('feed', { statements: 2 }),
      primitive('ping', { effects: [{ kind: 'enqueue', job: 'x', count: 1 }] }),
      primitive('gone', { outcome: 'unreached' }),
    ]);
    expect(rest).toEqual([]);
    // Coded like every other exercise warning line (`exercise-floor-verdict.ts`'s `asWarning`).
    expect(line).toStartWith('X_EXERCISE_EMPTY_REACH 1 reached primitive(s)');
    expect(line).toContain(' — fix: edit exercise.ts');
    expect(line).toContain('query health');
    expect(line).not.toContain('feed');
    expect(emptyReachWarnings([primitive('feed', { statements: 1 })])).toEqual([]);
  });

  test('past five it counts the rest rather than naming them', () => {
    const [line] = emptyReachWarnings(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n) => primitive(n)));
    expect(line).toContain('query e, and 2 more');
  });
});
