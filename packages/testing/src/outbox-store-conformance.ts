// The `OutboxStore` contract of `@ultimat3/jobs` as shared examples: `behavesLike(
// outboxStoreConformance, () => subject)`. A staged row lives or dies with its transaction; a claim
// is a LEASE fenced on its claimant, so two relays never publish one row and a lapsed one cannot
// touch a newer claimant's batch. The subject is called once per test and holds no rows.

import { expect, test } from 'bun:test';
import type { OutboxRecord } from '@ultimat3/jobs';
import { OUTBOX_STORE_CLAIM_CHECKS } from './outbox-store-conformance-claims';
import type { OutboxStoreCheck, OutboxStoreSubject } from './outbox-store-conformance-subject';
import { committed, outboxRecord } from './outbox-store-conformance-subject';
import type { SharedExamples } from './shared-examples';
import { sharedExamples } from './shared-examples';

export type { OutboxStoreCheck, OutboxStoreSubject } from './outbox-store-conformance-subject';

const ids = (records: readonly OutboxRecord[]): readonly string[] => records.map((each) => each.id);

const STAGE_CHECKS: readonly OutboxStoreCheck[] = [
  {
    name: 'a row staged in a rolled-back transaction is never claimed',
    async run(subject) {
      const store = subject.relay();
      const tx = await subject.transaction('rollback', (open) =>
        store.stage(open, outboxRecord(crypto.randomUUID())),
      );
      await store.rollback(tx);
      expect(await store.claim(10)).toEqual([]);
      expect(await store.pendingCount()).toBe(0);
    },
  },
  {
    name: 'commit reports what was staged; a claim hands each row back whole, claimant stamped',
    async run(subject) {
      const store = subject.relay();
      const records = [outboxRecord(crypto.randomUUID()), outboxRecord(crypto.randomUUID())];
      const sorted = [...records].sort((a, b) => (a.id < b.id ? -1 : 1));
      expect(ids(await committed(subject, store, records))).toEqual(ids(records));
      expect(await store.pendingCount()).toBe(2);
      const claims = await store.claim(10);
      expect(claims).toEqual(sorted.map((each) => ({ ...each, claimedBy: expect.any(String) })));
      expect(new Set(claims.map((each) => each.claimedBy)).size).toBe(1);
    },
  },
  {
    name: 'stageMany, when the store has it, stages every record of one transaction in order',
    async run(subject) {
      const store = subject.relay();
      const stageMany = store.stageMany?.bind(store);
      if (stageMany === undefined) return;
      const records = Array.from({ length: 3 }, () => outboxRecord(crypto.randomUUID()));
      const tx = await subject.transaction('commit', (open) => stageMany(open, records));
      expect(ids(await store.commit(tx))).toEqual(ids(records));
      expect(await store.pendingCount()).toBe(3);
    },
  },
];

export const OUTBOX_STORE_CHECKS: readonly OutboxStoreCheck[] = [
  ...STAGE_CHECKS,
  ...OUTBOX_STORE_CLAIM_CHECKS,
];

export const outboxStoreConformance: SharedExamples<
  OutboxStoreSubject | Promise<OutboxStoreSubject>
> = sharedExamples('an outbox store', (subject) => {
  for (const check of OUTBOX_STORE_CHECKS) {
    test(check.name, async () => {
      await check.run(await subject());
    });
  }
});
