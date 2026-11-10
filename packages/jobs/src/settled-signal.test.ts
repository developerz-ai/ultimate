// `onSettled` runs on a live signal. `executeJob`'s `finally` aborts the run's signal BEFORE the
// completed path's ack, so every completed hook used to run cancelled: `fetch(url, { signal })`
// failed, and now that a coded abort refuses writes, its writes would have too.

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { ctxOf, frozenClock, useContext } from '@ultimat3/core';
import type { DbClient } from '@ultimat3/db';
import { pgliteClient, raw, withTransaction } from '@ultimat3/db';
import { memoryJobDriver } from './driver-memory';
import type { JobHandle } from './job';
import { job, resetJobs } from './job';
import { passthrough } from './operator-surface-fixture';
import { ON_SETTLED_TIMEOUT_MS } from './settled';
import { jobWorker } from './worker';

const clock = frozenClock('2026-10-01T00:00:30.000Z');
const PGLITE_BOOT_MS = 30_000;

interface Seen {
  aborted?: boolean;
  committed?: boolean;
  outcome?: string;
}

let client: DbClient & { close(): Promise<void> };

beforeAll(async () => {
  client = pgliteClient();
  await client.execute(raw('create table settled_probe (id text primary key)'));
}, PGLITE_BOOT_MS);

afterAll(async () => {
  await client.close();
});

afterEach(() => resetJobs());

let minted = 0;
const declared = (
  seen: Seen,
  run: () => Promise<unknown>,
  extra: { readonly timeout?: number; readonly onSettledTimeout?: number } = {},
): JobHandle<{ readonly id: string }> => {
  minted += 1;
  const id = `row-${minted}`;
  return job<{ readonly id: string }, unknown>({
    name: `settled-signal-${minted}`,
    tenant: 'none',
    input: passthrough<{ readonly id: string }>(),
    idempotencyKey: (input) => input.id,
    retry: { attempts: 1, jitter: 'none', deadLetter: true },
    run,
    ...extra,
    async onSettled(settled) {
      seen.outcome = settled.outcome;
      seen.aborted = useContext().signal.aborted;
      await withTransaction((tx) => tx.execute(raw(`insert into settled_probe values ('${id}')`)), {
        client,
      });
      const rows = await client.query(raw(`select id from settled_probe where id = '${id}'`));
      seen.committed = rows.length === 1;
    },
  });
};

const drive = async (handle: JobHandle<{ readonly id: string }>): Promise<void> => {
  const driver = memoryJobDriver({ clock });
  await driver.enqueue({
    name: handle.name,
    queue: 'default',
    input: { id: 'one' },
    idempotencyKey: 'one',
    maxAttempts: 1,
  });
  await jobWorker({
    driver,
    queues: ['default'],
    workerId: 'worker-signal',
    heartbeatIntervalMs: 3_600_000,
    context: () => ctxOf({ role: 'worker', buildId: 'test' }),
    clock,
  }).tick();
};

/** A delay past 32 bits fires at ~1 ms, so these turns, armed after it, run after it too. */
const pastAnOverflowedTimer = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn += 1) await new Promise((done) => setTimeout(done, 1));
};

describe('onSettled sees a live signal', () => {
  test('after a completed run; its withTransaction commits', async () => {
    const seen: Seen = {};
    await drive(declared(seen, () => Promise.resolve('ok')));
    expect(seen.outcome).toBe('completed');
    expect(seen.aborted).toBe(false);
    expect(seen.committed).toBe(true);
  });

  test('after a run that timed out; its withTransaction commits', async () => {
    const seen: Seen = {};
    await drive(declared(seen, () => new Promise(() => undefined), { timeout: 5 }));
    expect(seen.outcome).toBe('dead-lettered');
    expect(seen.aborted).toBe(false);
    expect(seen.committed).toBe(true);
  });
});

describe('onSettled has a ceiling of its own', () => {
  const hanging = (
    seen: { aborted?: unknown; code?: unknown; fix?: unknown; calls: number },
    onSettledTimeout: number,
  ) => {
    minted += 1;
    return job<{ readonly id: string }, unknown>({
      name: `settled-ceiling-${minted}`,
      tenant: 'none',
      input: passthrough<{ readonly id: string }>(),
      idempotencyKey: (input) => input.id,
      retry: { attempts: 1, jitter: 'none' },
      onSettledTimeout,
      run: () => Promise.resolve('ok'),
      // The dead host: it waits on `ctx.signal`, and only that signal can end it.
      onSettled({ ctx }) {
        seen.calls += 1;
        return new Promise<void>((resolve) => {
          ctx.signal.addEventListener('abort', () => {
            seen.aborted = ctx.signal.aborted;
            seen.code = (ctx.signal.reason as { code?: unknown }).code;
            seen.fix = (ctx.signal.reason as { fix?: unknown }).fix;
            resolve();
          });
        });
      },
    });
  };

  test('a hook waiting on a dead host is aborted at it, once, and the worker gets its slot back', async () => {
    const seen = { calls: 0 } as {
      aborted?: unknown;
      code?: unknown;
      fix?: unknown;
      calls: number;
    };
    const started = performance.now();
    // A tick that stays hung fails this test at its own timeout.
    await drive(hanging(seen, 20));
    expect(performance.now() - started).toBeLessThan(300);
    expect(seen.aborted).toBe(true);
    expect(seen.code).toBe('X_JOB_TIMEOUT');
    // The hook's own knob: `timeout` is the attempt's, and raising it would not have helped.
    expect(seen.fix).toContain('onSettledTimeout');
    // The budget is the hook's, not one per try: a spent ceiling buys no second wait.
    expect(seen.calls).toBe(1);
  });

  test('a hook rejecting on the abort gets no second try: the budget is spent', async () => {
    minted += 1;
    let calls = 0;
    const handle = job<{ readonly id: string }, unknown>({
      name: `settled-ceiling-${minted}`,
      tenant: 'none',
      input: passthrough<{ readonly id: string }>(),
      idempotencyKey: (input) => input.id,
      retry: { attempts: 1, jitter: 'none' },
      onSettledTimeout: 20,
      run: () => Promise.resolve('ok'),
      onSettled: ({ ctx }) => {
        calls += 1;
        return new Promise<void>((_resolve, reject) => {
          ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason));
        });
      },
    });
    await drive(handle);
    await pastAnOverflowedTimer();
    expect(calls).toBe(1);
  });

  test('a hook that ignores its signal still gives the slot back', async () => {
    minted += 1;
    const handle = job<{ readonly id: string }, unknown>({
      name: `settled-ceiling-${minted}`,
      tenant: 'none',
      input: passthrough<{ readonly id: string }>(),
      idempotencyKey: (input) => input.id,
      retry: { attempts: 1, jitter: 'none' },
      onSettledTimeout: 20,
      run: () => Promise.resolve('ok'),
      onSettled: () => new Promise<void>(() => undefined),
    });
    // A tick that stays hung fails this test at its own timeout.
    await drive(handle);
  });

  test('a hook past its ceiling writes nothing', async () => {
    minted += 1;
    const id = `late-${minted}`;
    const hookDone = Promise.withResolvers<void>();
    let late: Promise<unknown> = Promise.resolve();
    const handle = job<{ readonly id: string }, unknown>({
      name: `settled-ceiling-${minted}`,
      tenant: 'none',
      input: passthrough<{ readonly id: string }>(),
      idempotencyKey: (input) => input.id,
      retry: { attempts: 1, jitter: 'none' },
      onSettledTimeout: 10,
      run: () => Promise.resolve('ok'),
      // Writes once the ceiling has passed, as a hook that ignored its signal until then does.
      onSettled: async ({ ctx }) => {
        await new Promise((passed) => ctx.signal.addEventListener('abort', passed));
        late = withTransaction(
          (tx) => tx.execute(raw(`insert into settled_probe values ('${id}')`)),
          { client },
        );
        late.finally(() => hookDone.resolve()).catch(() => undefined);
        await late;
      },
    });
    await drive(handle);
    await hookDone.promise;
    const outcome = await late.catch((error: unknown) => (error as { code?: unknown }).code);
    expect(outcome).toBe('X_JOB_TIMEOUT');
    expect(await client.query(raw(`select id from settled_probe where id = '${id}'`))).toEqual([]);
  });

  test('a ceiling that is no ceiling is refused at declaration', () => {
    for (const onSettledTimeout of [0, -1, Number.POSITIVE_INFINITY]) {
      expect(() =>
        job<{ readonly id: string }, unknown>({
          name: 'settled-ceiling-refused',
          tenant: 'none',
          input: passthrough<{ readonly id: string }>(),
          idempotencyKey: (input) => input.id,
          retry: { attempts: 1, jitter: 'none' },
          onSettledTimeout,
          run: () => Promise.resolve('ok'),
          onSettled: () => Promise.resolve(),
        }),
      ).toThrow();
    }
  });

  test('a ceiling past what a timer holds does not abort at once', async () => {
    const seen: { aborted?: unknown; code?: unknown; calls: number } = { calls: 0 };
    minted += 1;
    await drive(
      job<{ readonly id: string }, unknown>({
        name: `settled-ceiling-${minted}`,
        tenant: 'none',
        input: passthrough<{ readonly id: string }>(),
        idempotencyKey: (input) => input.id,
        retry: { attempts: 1, jitter: 'none' },
        onSettledTimeout: 2 ** 31 + 5,
        run: () => Promise.resolve('ok'),
        onSettled: async ({ ctx }) => {
          await pastAnOverflowedTimer();
          seen.aborted = ctx.signal.aborted;
        },
      }),
    );
    expect(seen.aborted).toBe(false);
  });

  test('the default is 30 seconds', () => {
    expect(ON_SETTLED_TIMEOUT_MS).toBe(30_000);
  });
});
