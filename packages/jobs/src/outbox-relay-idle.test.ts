// What an idle relay's long rest must still catch, on a fake clock. With the wake live an empty
// outbox costs one claim a minute at most (`IDLE_REST_MAX_MS`), and what the 5 s poll used to
// catch is held to a bound well under that: a row a dead relay was holding, and a notification
// lost with its session. A staged row still publishes at once.

import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import type { Clock } from '@ultimat3/core';
import type { Tx } from '@ultimat3/entity';
import type { EnqueueRequest, JobDriver } from './driver';
import { memoryJobDriver } from './driver-memory';
import { setWakeLive, signalStaged } from './enqueue-signal';
import { IDLE_POLL_CEILING_MS, IDLE_REST_MAX_MS } from './idle-backoff';
import type { OutboxRecord, OutboxStore } from './outbox';
import { memoryOutboxStore } from './outbox';
import { outboxRelay } from './outbox-relay';

const BASE_MS = 1_790_000_000_000;
const FLOOR_MS = 200;
const LEASE_MS = 20_000;

/** The store's clock, moved by the same fake timers that move the relay. */
const clock: Clock = {
  now: () => new Date(BASE_MS + performance.now()),
  monotonic: () => performance.now(),
};

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
  setWakeLive(false);
});

/** Fake time in `step` slices, letting each pass's promises settle between them. */
async function advance(ms: number, step = 10): Promise<void> {
  for (let gone = 0; gone < ms; gone += step) {
    jest.advanceTimersByTime(Math.min(step, ms - gone));
    for (let turn = 0; turn < 4; turn += 1) await new Promise((done) => setImmediate(done));
  }
}

/** The tx identity is the store's map key and nothing here reads a connection off it. */
const fakeTx = (id: string): Tx => ({ id }) as unknown as Tx;

const record = (id: string): OutboxRecord => ({
  id,
  runId: `run-${id}`,
  job: 'notifySubscribers',
  queue: 'default',
  input: {},
  idempotencyKey: `notify:${id}`,
  maxAttempts: 1,
  runAt: 0,
  stagedAt: 0,
});

function rig() {
  const inner = memoryOutboxStore({ clock, claimLeaseMs: LEASE_MS });
  const claims: number[] = [];
  const published: number[] = [];
  const t0 = performance.now();
  const store: OutboxStore = {
    ...inner,
    claim(limit, options) {
      claims.push(performance.now() - t0);
      return inner.claim(limit, options);
    },
  };
  const base = memoryJobDriver({ clock });
  const driver: JobDriver = {
    ...base,
    enqueueMany(requests: readonly EnqueueRequest[]) {
      for (const _ of requests) published.push(performance.now() - t0);
      return base.enqueueMany(requests);
    },
  };
  const relay = outboxRelay({ driver, store, clock, intervalMs: FLOOR_MS, drainOnShutdown: false });
  /** A committed row, announced (`signalStaged(true)`) or not — a NOTIFY that never arrived. */
  const commit = async (id: string, announced: boolean): Promise<void> => {
    const tx = fakeTx(id);
    await inner.stage(tx, record(id));
    await inner.commit(tx);
    if (announced) signalStaged(true);
  };
  const elapsed = (): number => performance.now() - t0;
  return { relay, inner, claims, published, commit, elapsed };
}

describe('an idle relay with a live wake', () => {
  test('claims an empty outbox at most once a minute, and publishes a staged row at once', async () => {
    setWakeLive(true);
    const r = rig();
    r.relay.start();
    try {
      await advance(10 * 60_000, 50);
      // Ten minutes: the first pass, then one per IDLE_REST_MAX_MS — never one per 5 s.
      expect(r.claims.length).toBeLessThanOrEqual(12);
      const before = r.elapsed();
      await r.commit('announced', true);
      await advance(50, 10);
      expect(r.published).toHaveLength(1);
      expect(r.published[0] ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(before + 50);
    } finally {
      await r.relay.stop();
    }
  });

  test("a dead relay's batch is re-claimed when its lease lapses, not a minute later", async () => {
    setWakeLive(true);
    const r = rig();
    await r.commit('stranded', false);
    // The relay that held it died: claimed, never published.
    expect(await r.inner.claim(10)).toHaveLength(1);
    r.relay.start();
    try {
      await advance(LEASE_MS + 2 * FLOOR_MS, 10);
      expect(r.published).toHaveLength(1);
    } finally {
      await r.relay.stop();
    }
  });

  test('a notification lost WITH its session: the rest is cut to the short ceiling', async () => {
    setWakeLive(true);
    const r = rig();
    r.relay.start();
    try {
      // Ten seconds into a rest, so a relay that armed a minute is still asleep when it goes.
      const lostAt = 130_000;
      await advance(lostAt, 50);
      setWakeLive(false);
      await r.commit('unheard', false);
      await advance(2 * IDLE_POLL_CEILING_MS + FLOOR_MS, 10);
      expect(r.published).toHaveLength(1);
    } finally {
      await r.relay.stop();
    }
  });

  test('a notification lost while the wake stays live: found within the rest', async () => {
    setWakeLive(true);
    const r = rig();
    r.relay.start();
    try {
      await advance(5_000, 50);
      await r.commit('unheard', false);
      await advance(IDLE_REST_MAX_MS + FLOOR_MS, 50);
      expect(r.published).toHaveLength(1);
    } finally {
      await r.relay.stop();
    }
  });
});
