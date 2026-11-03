// A keyed action past its deadline answers a success replay, with or without a `withTransaction`
// around it: the orphan finishing is what makes the replay true, so it runs in `runToCompletion`'s
// scope, and the root around the gate is marked to reach its COMMIT. The same body with no key
// rolls back. `idempotency-postgres.live.test.ts` repeats the second half on Postgres 17.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { ctxOf, runWithContext, UltimateError, useContext, userActor } from '@ultimat3/core';
import type { PgliteClient } from '@ultimat3/db';
import { pgliteClient, raw, sql, withTransaction } from '@ultimat3/db';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import {
  configureIdempotency,
  idempotencyCeilingMs,
  resetIdempotency,
  withIdempotency,
} from './idempotency';
import { memoryIdempotencyStore } from './idempotency-memory';
import {
  memoryUnderTest,
  postgresUnderTest,
  type TxHarness,
  txHarness,
} from './idempotency-tx-fixture';
import { invoke } from './invoke';
import { requestDeadlineMs } from './request-deadline';

const KEY = '["chargeCard","user","u1",null,"k1"]';

const timedOut = (): UltimateError =>
  new UltimateError({ code: 'X_TIMEOUT', cause: 'past the deadline', fix: 'raise it' });

/** A request's context, with the handle a test fires its deadline through. */
const request = () => {
  const controller = new AbortController();
  return {
    ctx: ctxOf({ actor: userActor({ id: 'u1' }), signal: controller.signal }),
    pastDeadline: () => controller.abort(timedOut()),
  };
};

/** A delay past 32 bits fires at ~1 ms, so these turns, armed after it, run after it too. */
const pastAnOverflowedTimer = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn += 1) await new Promise((done) => setTimeout(done, 1));
};

describe('a keyed action past its deadline', () => {
  const declared = (vendor: (signal: AbortSignal) => Promise<string>) =>
    action({
      input: t.object({ amount: t.number }),
      output: t.object({ charged: t.string }),
      policy: allow(),
      idempotent: true,
      handle: async ({ ctx }) => ({ charged: await vendor(ctx.signal) }),
    }).named('chargeOrphan');

  /** The vendor SDK a handler hands `ctx.signal` to: it rejects once that signal is aborted. */
  const vendorHonouringSignal = (onCall: () => void) => async (signal: AbortSignal) => {
    onCall();
    await Bun.sleep(0);
    signal.throwIfAborted();
    return 'ch_1';
  };

  test('whose handler passes ctx.signal onward still settles, and replays success', async () => {
    const store = memoryIdempotencyStore();
    const { ctx, pastDeadline } = request();
    let calls = 0;
    const target = declared(
      vendorHonouringSignal(() => {
        calls += 1;
        pastDeadline();
      }),
    );

    const first = await invoke(target, { amount: 1 }, { ctx, store, idempotencyKey: 'k1' });
    expect(first).toEqual({ charged: 'ch_1' });

    const replay = await invoke(target, { amount: 1 }, { ctx, store, idempotencyKey: 'k1' });
    expect(replay).toEqual({ charged: 'ch_1' });
    expect(calls).toBe(1);
  });

  test('the handler is handed the scope it runs in, ambient and parameter alike', async () => {
    const store = memoryIdempotencyStore();
    const { ctx, pastDeadline } = request();
    pastDeadline();
    const seen: boolean[] = [];
    const target = action({
      input: t.object({ amount: t.number }),
      output: t.object({ same: t.boolean }),
      policy: allow(),
      idempotent: true,
      handle: async ({ ctx: given }) => {
        seen.push(given.signal.aborted, useContext().signal.aborted);
        return { same: given === useContext() };
      },
    }).named('chargeScope');
    const answer = await invoke(target, { amount: 1 }, { ctx, store, idempotencyKey: 'k1' });
    expect(answer).toEqual({ same: true });
    expect(seen).toEqual([false, false]);
  });

  test('with no key there is no such scope: the same handler fails on the abort', async () => {
    const { ctx, pastDeadline } = request();
    const target = declared(vendorHonouringSignal(pastDeadline));
    const outcome = await invoke(target, { amount: 1 }, { ctx }).catch((error: unknown) => error);
    expect((outcome as { code?: string }).code).toBe('X_TIMEOUT');
  });
});

describe('a keyed action inside a transaction, past its deadline', () => {
  let client: PgliteClient;

  beforeAll(() => {
    client = pgliteClient();
  });

  afterAll(async () => {
    await client.close();
  });

  const STORES = [
    ['memory', () => Promise.resolve(memoryUnderTest())],
    ['postgres (embedded)', () => postgresUnderTest(client)],
  ] as const;

  for (const [name, build] of STORES) {
    describe(name, () => {
      let harness: TxHarness;

      beforeAll(async () => {
        harness = await txHarness(client, await build());
      });

      beforeEach(async () => {
        await harness.reset();
      });

      test('abort during the handler: COMMIT lands, settled, the row is there, the replay answers', async () => {
        const { ctx, pastDeadline } = request();
        await runWithContext(ctx, () =>
          harness.charge(KEY, 'ch_1', {
            during: async () => pastDeadline(),
          }),
        );
        expect(await harness.statusOf(KEY)).toBe('settled');
        expect(await harness.charges()).toEqual(['ch_1']);
        expect(await harness.charge(KEY, 'ch_2')).toEqual({
          value: { charged: 'ch_1' },
          replayed: true,
        });
      });

      test('the root stays marked after the gate returned: an `after` write rides the same COMMIT', async () => {
        const { ctx, pastDeadline } = request();
        await runWithContext(ctx, () =>
          harness.charge(KEY, 'ch_1', {
            during: async () => pastDeadline(),
            after: async () => {
              await withTransaction(
                (tx) => tx.execute(sql`insert into tx_charges (id) values ('ch_after')`),
                { client },
              );
            },
          }),
        );
        expect(await harness.charges()).toEqual(['ch_1', 'ch_after']);
      });
    });
  }

  test('the same body with no key rolls back', async () => {
    await client.execute(raw('create table if not exists tx_charges (id text primary key)'));
    await client.execute(raw('delete from tx_charges'));
    const { ctx, pastDeadline } = request();
    const reason = await runWithContext(ctx, () =>
      withTransaction(
        async (tx) => {
          await tx.execute(sql`insert into tx_charges (id) values ('unkeyed')`);
          pastDeadline();
          return 'charged';
        },
        { client },
      ),
    ).catch((error: unknown) => error);
    expect((reason as { code?: string }).code).toBe('X_TIMEOUT');
    const rows = await client.query(raw('select id from tx_charges'));
    expect(rows).toEqual([]);
  });
});

describe('a keyed run has a hard ceiling', () => {
  const hung = (seen: { reason?: unknown }) => () =>
    new Promise<never>((_resolve, reject) => {
      const { signal } = useContext();
      signal.addEventListener('abort', () => {
        seen.reason = signal.reason;
        reject(signal.reason);
      });
    });

  test('past it the run is aborted, the call rejects, and the key replays the failure', async () => {
    const store = memoryIdempotencyStore();
    const { ctx } = request();
    const seen: { reason?: unknown } = {};
    const error = await runWithContext(ctx, () =>
      withIdempotency(store, 'k1', { a: 1 }, hung(seen), { ceilingMs: 20 }),
    ).catch((thrown: unknown) => thrown);

    expect((error as { code?: string }).code).toBe('X_IDEMPOTENCY_RUN_CEILING');
    expect(seen.reason).toBe(error);
    expect((await store.get('k1'))?.status).toBe('failed');
    const replay = await runWithContext(ctx, () =>
      withIdempotency(store, 'k1', { a: 1 }, () => Promise.resolve('never'), { ceilingMs: 20 }),
    ).catch((thrown: unknown) => thrown);
    expect((replay as { code?: string }).code).toBe('X_IDEMPOTENCY_RUN_CEILING');
  });

  test('a handler ignoring its signal is let go of all the same', async () => {
    const store = memoryIdempotencyStore();
    const outcome = await withIdempotency(
      store,
      'k2',
      { a: 1 },
      () => new Promise(() => undefined),
      {
        ceilingMs: 20,
      },
    ).catch((thrown: unknown) => (thrown as { code?: string }).code);
    expect(outcome).toBe('X_IDEMPOTENCY_RUN_CEILING');
    expect((await store.get('k2'))?.status).toBe('failed');
  });

  test('under the ceiling nothing changes: the deadline is gone and the run settles', async () => {
    const store = memoryIdempotencyStore();
    const { ctx, pastDeadline } = request();
    const outcome = await runWithContext(ctx, () =>
      withIdempotency(
        store,
        'k3',
        { a: 1 },
        async () => {
          pastDeadline();
          await Bun.sleep(0);
          return useContext().signal.aborted;
        },
        { ceilingMs: 5_000 },
      ),
    );
    expect(outcome).toEqual({ value: false, replayed: false });
  });

  test('the scope publishes the instant, so an outbound hop forwards what is left', async () => {
    const store = memoryIdempotencyStore();
    const { ctx } = request();
    const outcome = await runWithContext(ctx, () =>
      withIdempotency(store, 'k4', { a: 1 }, async () => useContext().deadlineAt, {
        ceilingMs: 5_000,
      }),
    );
    expect(outcome.value).toBe(ctx.now().getTime() + 5_000);
  });

  test('a past-ceiling transaction rolls back: the marked root does not keep the row', async () => {
    const client = pgliteClient();
    try {
      await client.execute(raw('create table ceiling_rows (id text primary key)'));
      const store = memoryIdempotencyStore();
      const { ctx } = request();
      const outcome = await runWithContext(ctx, () =>
        withTransaction(
          () =>
            withIdempotency(
              store,
              'k5',
              { a: 1 },
              async () => {
                await withTransaction((tx) =>
                  tx.execute(sql`insert into ceiling_rows values ('hung')`),
                );
                return new Promise<never>(() => undefined);
              },
              { ceilingMs: 30 },
            ),
          { client },
        ),
      ).catch((thrown: unknown) => (thrown as { code?: string }).code);
      expect(outcome).toBe('X_IDEMPOTENCY_RUN_CEILING');
      expect(await client.query(raw('select id from ceiling_rows'))).toEqual([]);
      expect((await store.get('k5'))?.status).toBe('failed');
    } finally {
      await client.close();
    }
  }, 30_000);

  test('a ceiling that is no ceiling is refused at the call', async () => {
    const store = memoryIdempotencyStore();
    const outcome = await withIdempotency(store, 'k6', {}, () => Promise.resolve(1), {
      ceilingMs: Number.NaN,
    }).catch((thrown: unknown) => (thrown as { code?: string }).code);
    expect(outcome).toBe('X_INVARIANT');
  });

  test('configureIdempotency({ ceilingMs }) is the app-wide spelling', async () => {
    configureIdempotency({ scope: 'process', ceilingMs: 20 });
    try {
      const outcome = await withIdempotency(
        memoryIdempotencyStore(),
        'k7',
        {},
        () => new Promise(() => undefined),
      ).catch((thrown: unknown) => (thrown as { code?: string }).code);
      expect(outcome).toBe('X_IDEMPOTENCY_RUN_CEILING');
    } finally {
      resetIdempotency();
    }
  });

  test('a ceiling past what a timer holds does not fire at once', async () => {
    // `setTimeout` arms ~1 ms past 2^31-1: the "longer" ceiling killed every handler.
    const outcome = await withIdempotency(
      memoryIdempotencyStore(),
      'k8',
      {},
      async () => {
        await pastAnOverflowedTimer();
        return 'landed';
      },
      { ceilingMs: 2 ** 31 + 5 },
    );
    expect(outcome.value).toBe('landed');
  });

  test('a run throwing synchronously is that throw, settled, and no timer is left armed', async () => {
    const store = memoryIdempotencyStore();
    const failure = new RangeError('synchronous');
    const outcome = await withIdempotency(
      store,
      'k9',
      {},
      (() => {
        throw failure;
      }) as () => Promise<never>,
      { ceilingMs: 5_000 },
    ).catch((thrown: unknown) => thrown);
    expect(outcome).toBe(failure);
    expect((await store.get('k9'))?.status).toBe('failed');
  });

  test('a bad ceiling is a boot failure, never one per keyed request', () => {
    expect(() => configureIdempotency({ scope: 'process', ceilingMs: Number.NaN })).toThrow();
    expect(() => configureIdempotency({ scope: 'process', ceilingMs: 0 })).toThrow();
    resetIdempotency();
  });

  test('the default is twice the request deadline', () => {
    expect(idempotencyCeilingMs()).toBe(2 * requestDeadlineMs());
  });
});
