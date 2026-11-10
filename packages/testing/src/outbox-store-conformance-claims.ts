// The outbox store's claim checks: a claim is a lease, it lapses, it is handed back or retired by
// its claimant only, and its order is total. A store that hands one row to two relays hands one
// job to two workers, and the idempotency key collapses that only while the first is still live.

import { expect } from 'bun:test';
import type { OutboxRecord, OutboxStore } from '@ultimat3/jobs';
import type { OutboxStoreCheck } from './outbox-store-conformance-subject';
import { committed, elapse, outboxRecord, STAGED_AT } from './outbox-store-conformance-subject';

const ids = (records: readonly OutboxRecord[]): readonly string[] => records.map((each) => each.id);

/** The one claimant a batch was stamped with. */
const claimantOf = (records: readonly OutboxRecord[]): string =>
  records[0]?.claimedBy ?? expect.unreachable('a claimed batch carries its claimant');

/** Two committed rows, claimed by `store`. */
async function claimedPair(
  subject: Parameters<OutboxStoreCheck['run']>[0],
  store: OutboxStore,
): Promise<readonly OutboxRecord[]> {
  await committed(subject, store, [
    outboxRecord(crypto.randomUUID()),
    outboxRecord(crypto.randomUUID()),
  ]);
  const claims = await store.claim(10);
  expect(claims).toHaveLength(2);
  return claims;
}

export const OUTBOX_STORE_CLAIM_CHECKS: readonly OutboxStoreCheck[] = [
  {
    name: 'a claim is a lease: inside it, no relay claims the same rows again',
    async run(subject) {
      const [first, second] = [subject.relay(), subject.relay()];
      await claimedPair(subject, first);
      expect(await first.claim(10)).toEqual([]);
      expect(await second.claim(10)).toEqual([]);
      expect(await first.pendingCount()).toBe(2);
    },
  },
  {
    name: 'a lapsed claim is claimable again, so a relay that died strands nothing',
    async run(subject) {
      const [dead, live] = [subject.relay(), subject.relay()];
      const claims = await claimedPair(subject, dead);
      await elapse(subject, subject.claimLeaseMs * 2);
      expect(ids(await live.claim(10))).toEqual(ids(claims));
    },
  },
  {
    name: 'release, when the store has it, hands its claimant’s batch back at once',
    async run(subject) {
      const store = subject.relay();
      if (store.release === undefined) return;
      const claims = await claimedPair(subject, store);
      await store.release(ids(claims), claimantOf(claims));
      expect(ids(await subject.relay().claim(10))).toEqual(ids(claims));
    },
  },
  {
    name: 'a published row leaves the claim and the pending count, one or a batch at a time',
    async run(subject) {
      const store = subject.relay();
      const claims = await claimedPair(subject, store);
      const [one, other] = ids(claims);
      const by = claimantOf(claims);
      await store.markPublished(one ?? '', STAGED_AT + 5, by);
      expect(await store.pendingCount()).toBe(1);
      if (store.markPublishedMany === undefined) {
        await store.markPublished(other ?? '', STAGED_AT + 5, by);
      } else {
        await store.markPublishedMany([other ?? ''], STAGED_AT + 5, by);
      }
      expect(await store.pendingCount()).toBe(0);
      await elapse(subject, subject.claimLeaseMs * 2);
      expect(await subject.relay().claim(10)).toEqual([]);
    },
  },
  {
    // A relay that stalled past its lease wakes into a world where its batch is another relay's.
    name: 'a lapsed claimant can neither release nor retire what a newer claimant holds',
    async run(subject) {
      const [stale, fresh] = [subject.relay(), subject.relay()];
      const lapsed = await claimedPair(subject, stale);
      await elapse(subject, subject.claimLeaseMs * 2);
      const held = await fresh.claim(10);
      expect(ids(held)).toEqual(ids(lapsed));
      const staleBy = claimantOf(lapsed);
      await stale.release?.(ids(lapsed), staleBy);
      expect(await subject.relay().claim(10)).toEqual([]);
      for (const id of ids(lapsed)) await stale.markPublished(id, STAGED_AT + 5, staleBy);
      await stale.markPublishedMany?.(ids(lapsed), STAGED_AT + 5, staleBy);
      expect(await fresh.pendingCount()).toBe(2);
      for (const id of ids(held)) await fresh.markPublished(id, STAGED_AT + 9, claimantOf(held));
      expect(await fresh.pendingCount()).toBe(0);
    },
  },
  {
    // Every row of one transaction shares a `stagedAt`: a tie left which rows a limit takes, and
    // the order they publish in, to whatever the store iterated first.
    name: 'the claim order is total — stagedAt, then id — and a limit takes its head',
    async run(subject) {
      const store = subject.relay();
      const tied = Array.from({ length: 3 }, () => outboxRecord(crypto.randomUUID()));
      const earlier = outboxRecord(crypto.randomUUID(), { stagedAt: STAGED_AT - 1_000 });
      const byId = [...tied].sort((a, b) => (a.id < b.id ? -1 : 1));
      await committed(subject, store, [...[...byId].reverse(), earlier]);
      expect(ids(await store.claim(2))).toEqual([earlier.id, ...ids(byId.slice(0, 1))]);
      expect(ids(await store.claim(10))).toEqual(ids(byId.slice(1)));
    },
  },
];
