// A delivery is cancelled with its attempt — by the deadline and by a lost lease, never by the
// drain. The deadline nacks the job and another worker re-POSTs it, so a request left open there is
// the receiver getting the event twice, and an abandoned attempt that wrote the ledger counted a
// failure nobody saw toward `disableAfter`. The drain is the opposite case: a POST already on the
// wire finishes inside the drain budget, because tearing it down hands the job to the next pod,
// which re-POSTs the same event on every deploy.

import { beforeEach, describe, expect, test } from 'bun:test';
import { ctxOf, isUltimateError, UltimateError } from '@ultimat3/core';
import type { ClaimedJob } from './driver';
import { memoryJobDriver } from './driver-memory';
import { JobDrainedError } from './errors';
import { executeJob } from './execute';
import type { AnyJobHandle } from './job';
import { resetJobs } from './job';
import { webhook } from './webhook';
import type { WebhookFetch } from './webhook-attempt';
import { codeOf, ENDPOINT, harness, PUBLIC_IP, resetHarness } from './webhook-harness-fixture';
import { memoryWebhookLedger } from './webhook-ledger';

beforeEach(() => {
  resetJobs();
  resetHarness();
});

/**
 * A receiver that holds the request open until it is cancelled, and what `fetch` does then:
 * rejects with the signal's reason. Handed no signal, nothing can cancel it — so it lands.
 */
const heldOpen = (init: RequestInit): Promise<Response> =>
  new Promise<Response>((resolve, reject) => {
    const signal = init.signal;
    if (signal === undefined || signal === null) {
      resolve(new Response('ok', { status: 200 }));
      return;
    }
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

/** Poll, never a guessed sleep: what is awaited is an attempt the deadline already gave up on. */
async function until(condition: () => boolean): Promise<void> {
  for (let waited = 0; waited < 2_000; waited += 2) {
    if (condition()) return;
    await Bun.sleep(2);
  }
  expect.unreachable('the abandoned delivery never reached its fetch');
}

const drained = (): JobDrainedError => new JobDrainedError({ workerId: 'w1', signal: 'SIGTERM' });

/** One delivery on a memory queue, claimed, run through the real `executeJob` under `signal`. */
async function queued(options: { readonly timeout?: string; readonly fetch: WebhookFetch }) {
  const ledger = memoryWebhookLedger();
  const handle = webhook({
    name: 'partner-hooks-queued',
    tenant: 'none',
    ledger,
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
    resolve: () => Promise.resolve([PUBLIC_IP]),
    endpoint: () => ENDPOINT,
    event: () => ({ topic: 'orders.paid', body: '{"amount":100}' }),
    fetch: options.fetch,
  });
  const driver = memoryJobDriver();
  await driver.enqueue({
    name: handle.name,
    queue: 'default',
    input: { endpointId: 'ep_1', eventId: 'evt_1' },
    idempotencyKey: 'partner-hooks-queued:ep_1:evt_1',
    maxAttempts: 3,
  });
  const [claimed] = await driver.claim({
    queues: ['default'],
    limit: 1,
    visibilityTimeoutMs: 30_000,
    workerId: 'worker-test',
  });
  return {
    ledger,
    driver,
    execute: (signal?: AbortSignal) =>
      executeJob({
        driver,
        claimed: claimed as ClaimedJob,
        handle: handle as AnyJobHandle,
        ctx: ctxOf({ role: 'worker', buildId: 'test', signal }),
      }),
    row: () => driver.introspect?.job((claimed as ClaimedJob).id),
  };
}

describe('a delivery is cancelled with its attempt', () => {
  test("the attempt's signal reaches fetch and aborts it at the deadline", async () => {
    const signals: AbortSignal[] = [];
    let rejected = false;
    const delivery = await queued({
      timeout: '5ms',
      fetch: (_url, init) => {
        if (init.signal !== undefined && init.signal !== null) signals.push(init.signal);
        return heldOpen(init).catch((error: unknown) => {
          rejected = true;
          throw error;
        });
      },
    });

    const execution = await delivery.execute();

    expect(execution.outcome).toBe('retried');
    expect(execution.error).toContain('X_JOB_TIMEOUT');
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
    await until(() => rejected);
    await Bun.sleep(5);
    // The request was torn down, so the abandoned attempt has nothing to record — the queue's
    // next attempt is the one whose outcome the endpoint's count should hear.
    expect(delivery.ledger.attempts()).toHaveLength(0);
  });

  test('a delivery cancelled mid-request writes no ledger outcome and never disables', async () => {
    const one = harness({ disableAfter: 1 });
    const cancel = new AbortController();
    one.answer = (init) => {
      const open = heldOpen(init);
      cancel.abort(
        new UltimateError({
          code: 'X_ABORTED',
          cause: 'the attempt was cancelled by its deadline',
          fix: 'nothing: the queue re-runs the delivery',
        }),
      );
      return open;
    };

    let thrown: unknown;
    try {
      await one.run(1, ctxOf({ signal: cancel.signal }));
    } catch (error) {
      thrown = error;
    }

    // The cancellation's own reason, never a delivery failure that names the receiver.
    expect(isUltimateError(thrown) ? thrown.code : 'not-an-ultimate-error').toBe('X_ABORTED');
    expect(one.sent).toHaveLength(1);
    expect(one.ledger.attempts()).toHaveLength(0);
    expect(one.ledger.disabled().size).toBe(0);
  });

  test('a cancelled attempt never opens the socket at all', async () => {
    const one = harness();
    const cancel = new AbortController();
    cancel.abort();

    expect(await codeOf(() => one.run(1, ctxOf({ signal: cancel.signal })))).toBe('X_ABORTED');
    expect(one.sent).toHaveLength(0);
    expect(one.ledger.attempts()).toHaveLength(0);
  });
});

describe('the drain lets a POST on the wire finish', () => {
  /** A receiver that answers `status` once the drain has landed — never before it. */
  function answersAfterDrain(status: number) {
    const drain = new AbortController();
    const signals: AbortSignal[] = [];
    let sends = 0;
    const fetch: WebhookFetch = (_url, init) => {
      sends += 1;
      if (init.signal !== undefined && init.signal !== null) signals.push(init.signal);
      const open = heldOpen(init);
      // SIGTERM lands while the request is on the wire; the receiver answers a moment later.
      drain.abort(drained());
      return Promise.race([open, Bun.sleep(5).then(() => new Response('answered', { status }))]);
    };
    return { drain, signals, fetch, sends: () => sends };
  }

  test('a drain abort mid-request lets the POST finish and records success, with no resend', async () => {
    const receiver = answersAfterDrain(200);
    const delivery = await queued({ timeout: '5s', fetch: receiver.fetch });

    const execution = await delivery.execute(receiver.drain.signal);

    // Delivered and acked: the next pod has nothing to re-POST.
    expect(execution.outcome).toBe('completed');
    expect(receiver.sends()).toBe(1);
    expect(receiver.signals[0]?.aborted).toBe(false);
    expect(delivery.ledger.attempts().map((attempt) => attempt.ok)).toEqual([true]);
    expect((await delivery.row())?.state).not.toBe('ready');
  });

  test('a genuine failure during the drain is recorded as the failure it is', async () => {
    // Not an abort — the receiver really answered 500 — so the endpoint's count must hear it.
    const receiver = answersAfterDrain(500);
    const delivery = await queued({ timeout: '5s', fetch: receiver.fetch });

    await delivery.execute(receiver.drain.signal);

    expect(receiver.sends()).toBe(1);
    expect(delivery.ledger.attempts().map((attempt) => [attempt.ok, attempt.status])).toEqual([
      [false, 500],
    ]);
  });

  test('a drained POST still ends at the attempt deadline, where the job is handed on', async () => {
    // The drain is the run signal's FIRST reason, so the deadline behind it never reaches the
    // signal — yet `executeJob` still hands the job on at the deadline. A request left open past
    // that is the duplicate the deadline exists to prevent.
    const drain = new AbortController();
    const signals: AbortSignal[] = [];
    let rejected = false;
    const delivery = await queued({
      timeout: '20ms',
      fetch: (_url, init) => {
        if (init.signal !== undefined && init.signal !== null) signals.push(init.signal);
        const open = heldOpen(init).catch((error: unknown) => {
          rejected = true;
          throw error;
        });
        drain.abort(drained());
        return open;
      },
    });

    const execution = await delivery.execute(drain.signal);

    expect(execution.outcome).toBe('interrupted');
    await until(() => rejected);
    expect(signals[0]?.aborted).toBe(true);
    await Bun.sleep(5);
    expect(delivery.ledger.attempts()).toHaveLength(0);
  });

  test('a drain before the socket opens hands the job back without sending', async () => {
    let sends = 0;
    const delivery = await queued({
      fetch: () => {
        sends += 1;
        return Promise.resolve(new Response('ok', { status: 200 }));
      },
    });
    const drain = new AbortController();
    drain.abort(drained());

    const execution = await delivery.execute(drain.signal);

    expect(execution.outcome).toBe('interrupted');
    expect(sends).toBe(0);
    expect(delivery.ledger.attempts()).toHaveLength(0);
    expect((await delivery.row())?.state).toBe('ready');
  });
});
