// `defineExercise(…, { setup })`: the app's hook runs in the pass's sealed room, so a handler that
// calls a vendor is answered by the app's `mockFetch` and reached; the hook's resource is disposed
// with the pass; an `allowHost` in it is refused, and every path leaves the network as it found it.
// Several hooks run in order and are disposed in reverse; a throw disposes those that already ran.

import { describe, expect, test } from 'bun:test';
import { action, registerActions, t } from '@ultimat3/action';
import { isUltimateError } from '@ultimat3/core';
import { allow } from '@ultimat3/policy';
import { defineExercise, type ExerciseAppOptions } from './define-exercise';
import { runExercisePass } from './exercise';
import type { ExerciseRecord } from './exercise-report';
import { allowHost, captureNetwork, mockJson } from './sealed-network';
import type { SeedWriter } from './seed-graph-plan';
import { testName } from './test-types';

const VENDOR = 'https://vendor-setup.example.test/charge';
const writer: SeedWriter = {
  insert: async () => undefined,
  update: async () => undefined,
  snapshot: async (rows) => rows.map(() => 'unchanged'),
};

/** Fails unless the vendor answered: a sealed call throws, a mocked one returns its JSON. */
const exsCharge = action({
  input: t.object({}),
  output: t.object({ ok: t.boolean }),
  policy: allow('a vendor call is the subject here, not the policy'),
  async handle() {
    const answer = (await (await fetch(VENDOR, { method: 'POST' })).json()) as { id?: unknown };
    return { ok: answer.id === 'ch_1' };
  },
});
registerActions({ exsCharge });

const pass = async (app: ExerciseAppOptions): Promise<ExerciseRecord> => {
  const records = await runExercisePass({
    entities: [],
    writer,
    roles: () => [{ name: 'anonymous', actor: null }],
    only: 'exsCharge',
    overrides: defineExercise({}, app),
  });
  return records[0] as ExerciseRecord;
};

const failureOf = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return expect.unreachable('the pass ran');
};

describe(testName('unit', 'defineExercise setup'), () => {
  test('with no setup the vendor call is sealed: unreached', async () => {
    expect(await pass({})).toMatchObject({ outcome: 'unreached', code: 'X_TEST_NETWORK_SEALED' });
  });

  test("the setup's mockFetch answers the vendor: reached, the call counted, not refused", async () => {
    const before = captureNetwork();
    const record = await pass({ setup: () => mockJson(VENDOR, { id: 'ch_1' }) });
    expect(record.outcome).toBe('reached');
    expect(record.effects).toContainEqual({
      kind: 'network',
      method: 'POST',
      host: 'vendor-setup.example.test',
      refused: false,
    });
    // The route was the pass's: gone with it.
    expect(captureNetwork().mocks).toEqual(before.mocks);
  });

  test('what setup returns is disposed after the pass, before the network is restored', async () => {
    const order: string[] = [];
    const record = await pass({
      setup: async () => {
        order.push('setup');
        mockJson(VENDOR, { id: 'ch_1' });
        return {
          [Symbol.asyncDispose]: async () => {
            // Still inside the room: the route setup installed is still there.
            order.push(`dispose:${captureNetwork().mocks.length}`);
          },
        };
      },
    });
    expect(record.outcome).toBe('reached');
    expect(order).toEqual(['setup', 'dispose:1']);
  });

  test('a setup that lets a host through is X_EXERCISE_SETUP_UNSEALED; the seal is restored', async () => {
    const before = captureNetwork();
    const failure = await failureOf(() =>
      pass({ setup: () => allowHost('vendor-setup.example.test') }),
    );
    expect(isUltimateError(failure) && failure.code).toBe('X_EXERCISE_SETUP_UNSEALED');
    expect(isUltimateError(failure) && failure.cause).toContain('vendor-setup.example.test');
    expect(captureNetwork().allowed).toEqual(before.allowed);
  });

  test('a setup that throws refuses the pass with its own error, the room closed', async () => {
    const before = captureNetwork();
    const thrown = new TypeError('the vendor sdk would not load');
    // `async` and a throw: the setup's own rejection, typed as the hook's `Promise<void>`.
    const setup = async (): Promise<void> => {
      throw thrown;
    };
    expect(await failureOf(() => pass({ setup }))).toBe(thrown);
    expect(captureNetwork()).toEqual(before);
  });
});

/** A setup that logs its run and its dispose: `name` is one feature group's hook. */
const logged = (order: string[], name: string, route?: () => unknown) => async () => {
  order.push(`setup:${name}`);
  route?.();
  return { [Symbol.dispose]: () => void order.push(`dispose:${name}`) };
};

describe(testName('unit', 'defineExercise setup · several'), () => {
  test('an array runs in order, each answers, and is disposed in reverse', async () => {
    const order: string[] = [];
    const record = await pass({
      setup: [
        logged(order, 'billing'),
        logged(order, 'vendor', () => mockJson(VENDOR, { id: 'ch_1' })),
        logged(order, 'kyc'),
      ],
    });
    expect(record.outcome).toBe('reached');
    expect(order).toEqual([
      'setup:billing',
      'setup:vendor',
      'setup:kyc',
      'dispose:kyc',
      'dispose:vendor',
      'dispose:billing',
    ]);
  });

  test('a throw disposes those that already ran, in reverse, and refuses with its own error', async () => {
    const before = captureNetwork();
    const order: string[] = [];
    const thrown = new TypeError('the second group would not load');
    const failing = async (): Promise<void> => {
      order.push('setup:broken');
      throw thrown;
    };
    const failure = await failureOf(() =>
      pass({
        setup: [logged(order, 'one'), logged(order, 'two'), failing, logged(order, 'never')],
      }),
    );
    expect(failure).toBe(thrown);
    expect(order).toEqual(['setup:one', 'setup:two', 'setup:broken', 'dispose:two', 'dispose:one']);
    expect(captureNetwork()).toEqual(before);
  });

  test('an empty array is no setup: the vendor call is sealed', async () => {
    expect(await pass({ setup: [] })).toMatchObject({ code: 'X_TEST_NETWORK_SEALED' });
  });
});
