// The fourth contract assertion, against actions built to fail it. The probe that started this:
// `.contract()` passed with zero handler runs, and a real call of the same action threw an uncoded
// `TypeError`. Each test below is one verdict the exercise has to reach.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { EXERCISE_RUNS, isUltimateError, sealedHost, UltimateError } from '@ultimat3/core';
import type { PgliteClient } from '@ultimat3/db';
import { db, pgliteClient, raw, setDbClient, sql, withTransaction } from '@ultimat3/db';
import { allow, can, testActor } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import type { ContractTest } from './contract-test';
import { contractTestsFor } from './contract-test';
import { exerciseAction, exerciseTestName } from './exercise';
import { handlerReached } from './invoke';

const Input = t.object({ title: t.string.min(1).max(40), note: t.string.optional() });
const Output = t.object({ length: t.number });
const ADA = testActor('ada', { permissions: ['post:write'] }).actor;

const failureOf = async (run: () => Promise<unknown>): Promise<UltimateError> => {
  try {
    await run();
  } catch (error) {
    if (isUltimateError(error)) return error;
    expect.unreachable(`a coded refusal, got ${String(error)}`);
  }
  return expect.unreachable('the exercise passed');
};

const fourth = (contracts: readonly ContractTest[]): ContractTest => {
  const contract = contracts[3];
  if (contract === undefined) return expect.unreachable('contractTestsFor emitted no fourth test');
  return contract;
};

describe('the probe', () => {
  // `note` is optional, so a legal input omits it, and `.length` of `undefined` is a TypeError.
  const probe = action({
    input: Input,
    output: Output,
    policy: can('post:write'),
    handle: ({ input }) => ({ length: (input.note as string).length }),
  }).named('probeNote');

  test('the three older assertions pass on it, and the fourth fails X_CONTRACT_DEFECT', async () => {
    const contracts = probe.contract({ exercise: { actor: ADA } });
    for (const contract of contracts.slice(0, 3)) await contract.run();
    const failure = await failureOf(() => fourth(contracts).run());
    expect(failure.code).toBe('X_CONTRACT_DEFECT');
    expect(failure.cause).toContain('threw an uncoded TypeError');
    expect(failure.meta?.['run']).toBe(0);
    expect(failure.meta?.['input']).toEqual({ title: expect.any(String) });
    expect(failure.fix).toContain(`-t '${exerciseTestName('probeNote')}'`);
  });

  test('a rerun replays the same run with the same input: the seed is the name', async () => {
    const one = await failureOf(() => exerciseAction(probe, { actor: ADA }));
    const two = await failureOf(() => exerciseAction(probe, { actor: ADA }));
    expect(two.meta).toEqual(one.meta);
  });

  test('fixed, it passes, and every run reached the handler', async () => {
    const fixed = action({
      input: Input,
      output: Output,
      policy: can('post:write'),
      handle: ({ input }) => ({ length: input.note?.length ?? 0 }),
    }).named('probeNoteFixed');
    const before = handlerReached(fixed);
    const report = await exerciseAction(fixed, { actor: ADA });
    expect(report.reached).toBe(EXERCISE_RUNS);
    expect(handlerReached(fixed) - before).toBe(EXERCISE_RUNS);
  });
});

describe('verdicts', () => {
  const failing = (name: string, fail: () => unknown) =>
    action({
      input: Input,
      output: Output,
      policy: allow(),
      handle: fail as () => { length: number },
    }).named(name);

  test('zero runs reached is red, and the outcomes say what each hit', async () => {
    const denied = action({
      input: Input,
      output: Output,
      policy: can('post:write'),
      handle: () => ({ length: 1 }),
    }).named('deniedNote');
    const stranger = testActor('mara', { permissions: [] }).actor;
    const failure = await failureOf(() => exerciseAction(denied, { actor: stranger }));
    expect(failure.code).toBe('X_CONTRACT_EXERCISE_UNREACHED');
    const outcomes = failure.meta?.['outcomes'] as readonly string[];
    expect(outcomes).toHaveLength(EXERCISE_RUNS);
    expect(outcomes[0]).toBe('run 0: stopped before the handler with X_FORBIDDEN');
  });

  test('a coded refusal under 500 from the handler passes', async () => {
    const refusing = failing('missingNote', () => {
      throw new UltimateError({ code: 'X_NOT_FOUND', cause: 'no such note', fix: 'seed one' });
    });
    const report = await exerciseAction(refusing, { actor: null });
    expect(report.reached).toBe(EXERCISE_RUNS);
    expect(report.outcomes[0]).toBe('run 0: refused with X_NOT_FOUND');
  });

  test('a coded 5xx is a defect', async () => {
    const drifting = failing('driftNote', () => {
      throw new UltimateError({ code: 'X_DB_DRIFT', cause: 'schema drifted', fix: 'x db gen' });
    });
    const failure = await failureOf(() => exerciseAction(drifting, { actor: null }));
    expect(failure.code).toBe('X_CONTRACT_DEFECT');
    expect(failure.cause).toContain('answered X_DB_DRIFT, a 500');
  });

  test('an output its schema rejects is a defect', async () => {
    const lying = failing('lyingNote', () => ({ length: 'long' }));
    const failure = await failureOf(() => exerciseAction(lying, { actor: null }));
    expect(failure.code).toBe('X_CONTRACT_DEFECT');
    expect(failure.cause).toContain('output schema rejects');
  });

  test('a sealed network counts as unreached and names its host', async () => {
    const calling = failing('callingNote', () => {
      throw new UltimateError({
        code: 'X_TEST_NETWORK_SEALED',
        cause: 'POST https://api.example.test/v1/charge was not mocked (allowed hosts: none)',
        fix: 'mockFetch',
      });
    });
    const failure = await failureOf(() => exerciseAction(calling, { actor: null }));
    expect(failure.code).toBe('X_CONTRACT_EXERCISE_UNREACHED');
    expect((failure.meta?.['outcomes'] as readonly string[] | undefined)?.[0]).toBe(
      'run 0: network sealed (api.example.test)',
    );
    expect(sealedHost('nothing like a sealed cause')).toBe('an unnamed host');
  });

  test('an input binder that breaks every draw keeps X_CONTRACT_DRIFT, naming exercise.input', async () => {
    const fine = failing('boundNote', () => ({ length: 1 }));
    const failure = await failureOf(() =>
      exerciseAction(fine, { actor: null, input: (drawn) => ({ ...drawn, title: '' }) }),
    );
    expect(failure.code).toBe('X_CONTRACT_DRIFT');
    expect(failure.fix).toContain('exercise: { actor, input:');
  });

  test('a deploy is refused before a run: generated input never reaches production', async () => {
    let calls = 0;
    const counted = failing('deployedNote', () => {
      calls += 1;
      return { length: 1 };
    });
    const previous = process.env['ULTIMATE_ENV'];
    process.env['ULTIMATE_ENV'] = 'production';
    try {
      const failure = await failureOf(() => exerciseAction(counted, { actor: null }));
      expect(failure.code).toBe('X_CONTRACT_EXERCISE_ENVIRONMENT');
    } finally {
      if (previous === undefined) delete process.env['ULTIMATE_ENV'];
      else process.env['ULTIMATE_ENV'] = previous;
    }
    expect(calls).toBe(0);
  });

  test('runs outside 1..64 are refused rather than clamped', async () => {
    const fine = failing('runsNote', () => ({ length: 1 }));
    for (const runs of [0, 65, 1.5]) {
      expect((await failureOf(() => exerciseAction(fine, { actor: null, runs }))).code).toBe(
        'X_INVARIANT',
      );
    }
    expect((await exerciseAction(fine, { actor: null, runs: 2 })).runs).toBe(2);
  });
});

describe('declaring the exercise', () => {
  const guarded = action({
    input: Input,
    output: Output,
    policy: can('post:write'),
    handle: () => ({ length: 1 }),
  }).named('guardedDeclare');

  test('a guarded action with no exercise is X_CONTRACT_EXERCISE_UNDECLARED', async () => {
    const failure = await failureOf(() => fourth(contractTestsFor(guarded)).run());
    expect(failure.code).toBe('X_CONTRACT_EXERCISE_UNDECLARED');
    expect(failure.fix).toContain(
      'defineExercise({ guardedDeclare: { actor } })   # in apps/web/exercise.ts',
    );
  });

  test('an opt-out is listed with its reason; a blank one is refused', async () => {
    const off = fourth(contractTestsFor(guarded, { exercise: { off: 'charges a card' } }));
    expect(off.name).toBe('guardedDeclare: handler exercise off: charges a card');
    await off.run();
    const blank = fourth(contractTestsFor(guarded, { exercise: { off: '  ' } }));
    expect((await failureOf(() => blank.run())).code).toBe('X_CONTRACT_EXERCISE_UNDECLARED');
  });

  test('a public action exercises as the signed-out caller with nothing declared', async () => {
    const open = action({
      input: Input,
      output: Output,
      policy: allow(),
      handle: () => ({ length: 1 }),
    }).named('openDeclare');
    const before = handlerReached(open);
    await fourth(contractTestsFor(open)).run();
    expect(handlerReached(open) - before).toBe(EXERCISE_RUNS);
  });
});

describe('every run rolls back — PGlite', () => {
  let client: PgliteClient;
  const writing = action({
    input: Input,
    output: Output,
    policy: allow(),
    async handle({ input }) {
      await db().execute(sql`insert into exercised (title) values (${input.title})`);
      return { length: input.title.length };
    },
  }).named('writingNote');

  const count = async (): Promise<number> =>
    (await client.query<{ n: number }>(raw('select count(*)::int as n from exercised')))[0]?.n ??
    -1;

  beforeAll(async () => {
    client = pgliteClient();
    await client.execute(raw('create table exercised (title text not null)'));
    setDbClient(client);
  });

  afterAll(async () => {
    setDbClient(undefined);
    await client.close();
  });

  test('a write made by every run is gone after the exercise', async () => {
    const report = await exerciseAction(writing, { actor: null });
    expect(report.reached).toBe(EXERCISE_RUNS);
    expect(await count()).toBe(0);
  });

  test('inside a test transaction it is a savepoint, and the outer scope keeps its own write', async () => {
    await withTransaction(async (tx) => {
      await tx.execute(sql`insert into exercised (title) values ('kept')`);
      await exerciseAction(writing, { actor: null, runs: 4 });
      expect(
        (await tx.query<{ n: number }>(raw('select count(*)::int as n from exercised')))[0]?.n,
      ).toBe(1);
    });
    expect(await count()).toBe(1);
  });
});
