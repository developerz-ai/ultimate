// `enqueue` past a coded abort starts no job, on either path: a direct `driver.enqueue` is a write
// the transaction guard cannot see, and a staged row would ride a COMMIT the guard is about to
// refuse. A client hang-up keeps enqueuing, and `runToCompletion` lands one.

import { afterEach, describe, expect, test } from 'bun:test';
import { ctxOf, runToCompletion, runWithContext, UltimateError } from '@ultimat3/core';
import type { Tx } from '@ultimat3/entity';
import { memoryJobDriver } from './driver-memory';
import type { JobHandle } from './job';
import { job, resetJobs } from './job';
import { passthrough } from './operator-surface-fixture';
import { memoryOutboxStore, outboxJobsFacade } from './outbox';

afterEach(() => resetJobs());

const abortedWith = (reason: unknown): AbortSignal => {
  const controller = new AbortController();
  controller.abort(reason);
  return controller.signal;
};

const timedOut = (): UltimateError =>
  new UltimateError({ code: 'X_TIMEOUT', cause: 'past the deadline', fix: 'raise it' });

const declared = (): JobHandle<{ readonly id: string }> =>
  job<{ readonly id: string }, void>({
    name: 'outbox-abandon',
    tenant: 'none',
    input: passthrough<{ readonly id: string }>(),
    idempotencyKey: ({ id }) => id,
    retry: { attempts: 1, jitter: 'none' },
    run: () => Promise.resolve(),
  });

const TX: Tx = { query: () => Promise.resolve([]) } as unknown as Tx;

const facadeOver = (open: Tx | undefined) => {
  const driver = memoryJobDriver();
  const store = memoryOutboxStore();
  const staged: unknown[] = [];
  const stage: typeof store.stage = (tx, record) => {
    staged.push(record);
    return store.stage(tx, record);
  };
  const facade = outboxJobsFacade({ driver, store: { ...store, stage } }, () => open);
  const enqueued = async () => (await driver.introspect?.list({}))?.length ?? 0;
  return { facade, staged, enqueued };
};

describe('enqueue past the abort', () => {
  test('direct to the driver: refused with the signal reason, nothing enqueued', async () => {
    const { facade, enqueued } = facadeOver(undefined);
    const reason = timedOut();
    const outcome = await runWithContext(ctxOf({ signal: abortedWith(reason) }), () =>
      facade.enqueue(declared(), { id: 'a' }).catch((error: unknown) => error),
    );
    expect(outcome).toBe(reason);
    expect(await enqueued()).toBe(0);
  });

  test('staged in a transaction: refused with the signal reason, nothing staged', async () => {
    const { facade, staged } = facadeOver(TX);
    const reason = timedOut();
    const outcome = await runWithContext(ctxOf({ signal: abortedWith(reason) }), () =>
      facade.enqueue(declared(), { id: 'a' }).catch((error: unknown) => error),
    );
    expect(outcome).toBe(reason);
    expect(staged).toEqual([]);
  });

  test('a client hang-up keeps enqueuing', async () => {
    const { facade, enqueued } = facadeOver(undefined);
    const hangUp = new DOMException('The operation was aborted.', 'AbortError');
    await runWithContext(ctxOf({ signal: abortedWith(hangUp) }), () =>
      facade.enqueue(declared(), { id: 'a' }),
    );
    expect(await enqueued()).toBe(1);
  });

  test('runToCompletion lands it', async () => {
    const { facade, enqueued } = facadeOver(undefined);
    await runWithContext(ctxOf({ signal: abortedWith(timedOut()) }), () =>
      runToCompletion(() => facade.enqueue(declared(), { id: 'a' })),
    );
    expect(await enqueued()).toBe(1);
  });
});
