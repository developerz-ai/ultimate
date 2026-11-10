// The outbox-store suite over `memoryOutboxStore()` on a frozen clock, and the proof it can fail: a
// claim that is only a read (handed back the moment it is taken), and a mark that drops the
// claimant — so a relay whose lease lapsed retires rows a newer one has not published.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import type { Tx } from '@ultimat3/entity';
import type { OutboxStore } from '@ultimat3/jobs';
import { memoryOutboxStore } from '@ultimat3/jobs';
import type { OutboxStoreSubject } from './outbox-store-conformance';
import { OUTBOX_STORE_CHECKS, outboxStoreConformance } from './outbox-store-conformance';
import { behavesLike } from './shared-examples';
import { testName } from './test-types';

const LEASE_MS = 1_000;

/** One store, every relay: its fence token is per claim, so one instance plays them all. */
const onFrozenClock = (wrap: (inner: OutboxStore) => OutboxStore = (inner) => inner) => {
  const clock = frozenClock('2026-11-09T00:00:00.000Z');
  const store = wrap(memoryOutboxStore({ clock, claimLeaseMs: LEASE_MS }));
  let txs = 0;
  const subject: OutboxStoreSubject = {
    relay: () => store,
    claimLeaseMs: LEASE_MS,
    elapse: clock.advance,
    async transaction(_outcome, body) {
      txs += 1;
      const tx: Tx = { id: `tx-${txs}`, onRollback: () => undefined };
      await body(tx);
      return tx;
    },
  };
  return subject;
};

describe(testName('unit', 'the memory outbox store'), () => {
  behavesLike(outboxStoreConformance, () => onFrozenClock());
});

/** A claim that takes the rows and hands them straight back: a read with a claimant stamped on. */
const readOnly = (inner: OutboxStore): OutboxStore => ({
  ...inner,
  async claim(limit) {
    const rows = await inner.claim(limit);
    await inner.release?.(rows.map((each) => each.id));
    return rows;
  },
});

/** Marks that forget who is asking: the store cannot fence what it is not told. */
const unfencedMark = (inner: OutboxStore): OutboxStore => ({
  ...inner,
  markPublished: (id, at) => inner.markPublished(id, at),
  markPublishedMany: (ids, at) => inner.markPublishedMany?.(ids, at) ?? Promise.resolve(),
});

const check = (prefix: string) =>
  OUTBOX_STORE_CHECKS.find((each) => each.name.startsWith(prefix)) ??
  expect.unreachable(`no outbox-store check named ${prefix}`);

describe(testName('unit', 'a store that breaks the outbox contract fails conformance'), () => {
  test('a claim that is a read hands one row to two relays', async () => {
    await check('commit reports').run(onFrozenClock(readOnly));
    await expect(check('a claim is a lease').run(onFrozenClock(readOnly))).rejects.toThrow();
  });

  test('a mark with no fence lets a lapsed relay retire a live batch', async () => {
    await check('a published row').run(onFrozenClock(unfencedMark));
    await expect(check('a lapsed claimant').run(onFrozenClock(unfencedMark))).rejects.toThrow();
  });

  test('every check has a name of its own', () => {
    const names = OUTBOX_STORE_CHECKS.map((each) => each.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
