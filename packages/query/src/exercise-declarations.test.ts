// One declaration of a read's exercise: `.contract({ exercise })` handed the app's
// `defineExercise()` value reads the entry named for the query — the one `x exercise` reads.

import { describe, expect, test } from 'bun:test';
import { isUltimateError, type UltimateError, userActor } from '@ultimat3/core';
import { allow, can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import type { QueryContractTest } from './contract-test';
import type { QueryExerciseDeclarations, QueryExerciseOptions } from './exercise-declarations';
import { query } from './query';
import { from } from './source';

const Input = t.object({ term: t.string.max(20) });
const reader = { ...userActor({ id: 'u1' }), permissions: ['feed:read'] };

const declared = (entries: Record<string, QueryExerciseOptions>): QueryExerciseDeclarations => ({
  kind: 'exercise-overrides',
  entries: new Map(Object.entries(entries)),
});

const only = (contracts: readonly QueryContractTest[]): QueryContractTest =>
  contracts[0] ?? expect.unreachable('queryContractTestsFor emitted nothing');

const failureOf = async (run: () => Promise<unknown>): Promise<UltimateError> => {
  try {
    await run();
  } catch (error) {
    if (isUltimateError(error)) return error;
    expect.unreachable(`a coded refusal, got ${String(error)}`);
  }
  return expect.unreachable('the exercise passed');
};

/** A guarded read recording who each reached run read as. */
const feed = (name: string, seen: string[], policy = can('feed:read')) =>
  query({
    input: Input,
    policy,
    sql: (_input, ctx) => {
      seen.push(ctx.actor.id);
      return from<{ id: string }>('posts', [{ id: 'a' }]);
    },
  }).named(name);

describe('.contract({ exercise }) with the app declarations', () => {
  test('runs the entry named for the query, as its actor', async () => {
    const seen: string[] = [];
    const exercise = declared({ declaredFeed: { actor: reader }, otherFeed: { off: 'n/a' } });
    await only(feed('declaredFeed', seen).contract({ exercise })).run();
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set([reader.id]));
  });

  test("a kind-qualified entry is the query's, and wins over the bare name", async () => {
    const seen: string[] = [];
    const nobody = { ...userActor({ id: 'nobody' }), permissions: [] };
    const exercise = declared({
      qualifiedFeed: { actor: nobody },
      'query:qualifiedFeed': { actor: reader },
    });
    await only(feed('qualifiedFeed', seen).contract({ exercise })).run();
    expect(new Set(seen)).toEqual(new Set([reader.id]));
    const alone = declared({ 'query:qualifiedFeed': { off: 'qualified' } });
    expect(only(feed('qualifiedFeed', []).contract({ exercise: alone })).name).toBe(
      'qualifiedFeed: read exercise off: qualified',
    );
  });

  test('an entry turned off is listed with its reason', () => {
    const exercise = declared({ offFeed: { off: 'a vendor index' } });
    expect(only(feed('offFeed', []).contract({ exercise })).name).toBe(
      'offFeed: read exercise off: a vendor index',
    );
  });

  test('no entry for a guarded read is X_CONTRACT_EXERCISE_UNDECLARED, naming exercise.ts', async () => {
    const exercise = declared({ otherFeed: { actor: reader } });
    const failure = await failureOf(() =>
      only(feed('missingFeed', []).contract({ exercise })).run(),
    );
    expect(failure.code).toBe('X_CONTRACT_EXERCISE_UNDECLARED');
    expect(failure.cause).toContain('apps/web/exercise.ts');
    expect(failure.fix).toContain(
      'defineExercise({ missingFeed: { actor } })   # in apps/web/exercise.ts',
    );
  });

  test('no entry for a public read reads as the signed-out reader', async () => {
    const seen: string[] = [];
    await only(feed('publicFeed', seen, allow()).contract({ exercise: declared({}) })).run();
    expect(seen.length).toBeGreaterThan(0);
  });
});
