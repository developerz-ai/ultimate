// The read twin of action's exercise: generated legal input through `sourceFor` and `execute()`.
// A read that crashes on a filter its own schema allows ships green without this suite.

import { describe, expect, test } from 'bun:test';
import { EXERCISE_RUNS, isUltimateError, UltimateError, userActor } from '@ultimat3/core';
import { allow, can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import type { QueryContractTest } from './contract-test';
import { queryContractTestsFor } from './contract-test';
import { exerciseQuery, queryExerciseTestName } from './exercise';
import { query } from './query';
import { from } from './source';

interface Post {
  readonly id: string;
  readonly title: string;
}

const Input = t.object({ term: t.string.max(20), limit: t.number.int().min(1).max(50).optional() });
const POSTS: readonly Post[] = [{ id: 'a', title: 'hello' }];
const reader = { ...userActor({ id: 'u1' }), permissions: ['feed:read'] };

const failureOf = async (run: () => Promise<unknown>): Promise<UltimateError> => {
  try {
    await run();
  } catch (error) {
    if (isUltimateError(error)) return error;
    expect.unreachable(`a coded refusal, got ${String(error)}`);
  }
  return expect.unreachable('the exercise passed');
};

const only = (contracts: readonly QueryContractTest[]): QueryContractTest => {
  const contract = contracts[0];
  if (contract === undefined) return expect.unreachable('queryContractTestsFor emitted nothing');
  return contract;
};

const feed = (
  name: string,
  sql: (input: { term: string; limit?: number | undefined }) => unknown,
) =>
  query({
    input: Input,
    policy: can('feed:read'),
    sql: (input) => {
      sql(input);
      return from<Post>('posts', POSTS).limit(input.limit ?? 10);
    },
  }).named(name);

describe('exerciseQuery', () => {
  test('a read that crashes on a legal input is X_CONTRACT_DEFECT, through .contract()', async () => {
    // `limit` is optional: a legal input omits it, and `.toFixed` of `undefined` is a TypeError.
    const probe = feed('probeFeed', (input) => (input.limit as number).toFixed());
    const contract = only(probe.contract({ exercise: { actor: reader } }));
    expect(contract.name).toBe(queryExerciseTestName('probeFeed'));
    const failure = await failureOf(() => contract.run());
    expect(failure.code).toBe('X_CONTRACT_DEFECT');
    expect(failure.cause).toContain('threw an uncoded TypeError');
    expect(failure.meta?.['run']).toBe(0);
  });

  test('a read that survives passes, and every run reached sql()', async () => {
    const fine = feed('fineFeed', () => undefined);
    const report = await exerciseQuery(fine, { actor: reader });
    expect(report.reached).toBe(EXERCISE_RUNS);
  });

  test('a denied reader reaches nothing, which is red', async () => {
    const fine = feed('deniedFeed', () => undefined);
    const failure = await failureOf(() => exerciseQuery(fine, { actor: userActor({ id: 'u2' }) }));
    expect(failure.code).toBe('X_CONTRACT_EXERCISE_UNREACHED');
    expect((failure.meta?.['outcomes'] as readonly string[] | undefined)?.[0]).toBe(
      'run 0: stopped before sql() with X_FORBIDDEN',
    );
  });

  test('a coded refusal under 500 passes; a coded 5xx is a defect', async () => {
    const missing = feed('missingFeed', () => {
      throw new UltimateError({ code: 'X_NOT_FOUND', cause: 'gone', fix: 'seed one' });
    });
    expect((await exerciseQuery(missing, { actor: reader })).reached).toBe(0 + EXERCISE_RUNS);
    const drifting = feed('driftFeed', () => {
      throw new UltimateError({ code: 'X_DB_DRIFT', cause: 'drifted', fix: 'x db gen' });
    });
    const failure = await failureOf(() => exerciseQuery(drifting, { actor: reader }));
    expect(failure.code).toBe('X_CONTRACT_DEFECT');
  });

  test('a deploy is refused before a read runs', async () => {
    let calls = 0;
    const counted = feed('deployedFeed', () => {
      calls += 1;
    });
    const previous = process.env['ULTIMATE_ENV'];
    process.env['ULTIMATE_ENV'] = 'staging';
    try {
      const failure = await failureOf(() => exerciseQuery(counted, { actor: reader }));
      expect(failure.code).toBe('X_CONTRACT_EXERCISE_ENVIRONMENT');
    } finally {
      if (previous === undefined) delete process.env['ULTIMATE_ENV'];
      else process.env['ULTIMATE_ENV'] = previous;
    }
    expect(calls).toBe(0);
  });

  test('a defect keeps what the read threw: meta.failure and the source error', async () => {
    const drifting = feed('failureFeed', () => {
      throw new UltimateError({ code: 'X_DB_DRIFT', cause: 'drifted', fix: 'x db gen' });
    });
    const failure = await failureOf(() => exerciseQuery(drifting, { actor: reader }));
    expect(failure.meta?.['failure']).toEqual({ code: 'X_DB_DRIFT', cause: 'drifted' });
  });

  test('a binder that breaks every draw keeps X_CONTRACT_DRIFT', async () => {
    const fine = feed('boundFeed', () => undefined);
    const failure = await failureOf(() =>
      exerciseQuery(fine, { actor: reader, input: () => ({ term: 1 }) }),
    );
    expect(failure.code).toBe('X_CONTRACT_DRIFT');
  });
});

describe('declaring the exercise', () => {
  test('a guarded read with nothing declared is X_CONTRACT_EXERCISE_UNDECLARED', async () => {
    const guarded = feed('guardedFeed', () => undefined);
    const failure = await failureOf(() => only(queryContractTestsFor(guarded)).run());
    expect(failure.code).toBe('X_CONTRACT_EXERCISE_UNDECLARED');
    expect(failure.fix).toContain(
      'defineExercise({ guardedFeed: { actor } })   # in apps/web/exercise.ts',
    );
  });

  test('an opt-out is listed with its reason, and a blank one is refused', async () => {
    const guarded = feed('offFeed', () => undefined);
    const off = only(guarded.contract({ exercise: { off: 'reads a vendor index' } }));
    expect(off.name).toBe('offFeed: read exercise off: reads a vendor index');
    await off.run();
    const blank = only(guarded.contract({ exercise: { off: '' } }));
    expect((await failureOf(() => blank.run())).code).toBe('X_CONTRACT_EXERCISE_UNDECLARED');
  });

  test('a public read exercises as the signed-out reader', async () => {
    const open = query({
      input: Input,
      policy: allow(),
      sql: () => from<Post>('posts', POSTS),
    }).named('openFeed');
    await only(open.contract()).run();
  });

  test('runs outside 1..64 are refused', async () => {
    const fine = feed('runsFeed', () => undefined);
    expect((await failureOf(() => exerciseQuery(fine, { actor: reader, runs: 0 }))).code).toBe(
      'X_INVARIANT',
    );
  });
});
