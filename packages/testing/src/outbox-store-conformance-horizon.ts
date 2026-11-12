// The outbox store's idle answer: a claim that took nothing says when the first row a relay holds
// has its lease lapse (`onEmpty`) — what an idle relay rests on instead of polling every 5 s. A
// store that never said it left the relay polling; one that said it wrong stranded a dead relay's
// batch for a minute.

import { expect } from 'bun:test';
import type { OutboxStore } from '@ultimat3/jobs';
import type { OutboxStoreCheck } from './outbox-store-conformance-subject';
import { committed, elapse, outboxRecord } from './outbox-store-conformance-subject';

/** One claim, and what its `onEmpty` was told — `'untold'` when it was not called. */
async function hearing(
  store: OutboxStore,
): Promise<{ readonly taken: number; readonly told: number | null | 'untold' }> {
  let told: number | null | 'untold' = 'untold';
  const claimed = await store.claim(10, {
    onEmpty: (dueInMs) => {
      told = dueInMs;
    },
  });
  return { taken: claimed.length, told };
}

/** Slack for the database's clock against the statement's own time. */
const SKEW_MS = 500;

export const OUTBOX_STORE_HORIZON_CHECKS: readonly OutboxStoreCheck[] = [
  {
    name: 'an empty claim says when a held row’s lease lapses, and nothing when none is held',
    async run(subject) {
      const [dead, idle] = [subject.relay(), subject.relay()];
      expect(await hearing(idle)).toEqual({ taken: 0, told: null });
      await committed(subject, dead, [outboxRecord(crypto.randomUUID())]);
      // A claim that TOOK rows is not empty: nothing is told.
      expect(await hearing(dead)).toEqual({ taken: 1, told: 'untold' });
      const held = await hearing(idle);
      expect(held.taken).toBe(0);
      expect(held.told).toBeGreaterThan(subject.claimLeaseMs - SKEW_MS);
      expect(held.told).toBeLessThanOrEqual(subject.claimLeaseMs + SKEW_MS);
      await elapse(subject, subject.claimLeaseMs / 2);
      const later = await hearing(idle);
      expect(later.told).toBeLessThanOrEqual(subject.claimLeaseMs / 2 + SKEW_MS);
      expect(later.told).toBeGreaterThan(subject.claimLeaseMs / 2 - SKEW_MS);
    },
  },
];
