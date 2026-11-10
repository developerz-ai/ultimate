// What an outbox-store check is handed — the subject: relays over shared rows, a transaction of
// the backing store, its clock — and the record and staging helpers every check builds on.

import type { Tx } from '@ultimat3/entity';
import type { OutboxRecord, OutboxStore } from '@ultimat3/jobs';

export interface OutboxStoreSubject {
  /**
   * One relay's store over the subject's shared rows. Called once per relay a check plays: a store
   * whose fence token is per instance (`postgresOutboxStore`'s `relayId`) answers a new one each
   * call; one whose token is per claim (`memoryOutboxStore`) may answer itself.
   */
  relay(): OutboxStore;
  /** The `claimLeaseMs` every relay was built with. */
  readonly claimLeaseMs: number;
  /**
   * Run `body` inside a transaction of the backing store that then commits or rolls back, and
   * answer the `Tx` it was handed. The suite calls `commit`/`rollback` on the store after, as the
   * transaction runner does.
   */
  transaction(outcome: 'commit' | 'rollback', body: (tx: Tx) => Promise<void>): Promise<Tx>;
  /** Let `ms` pass for every claim: `clock.advance`, or `claimed_at` moved back by `ms`. */
  readonly elapse: (ms: number) => void | Promise<void>;
}

export interface OutboxStoreCheck {
  readonly name: string;
  run(subject: OutboxStoreSubject): Promise<void>;
}

/** One instant for every staged row: the claim's sort key then ties, and `id` must break it. */
export const STAGED_AT = Date.UTC(2026, 10, 9, 9, 0, 0);

/** A record with every optional field set, so a store that drops one is seen dropping it. */
export const outboxRecord = (id: string, extra: Partial<OutboxRecord> = {}): OutboxRecord => ({
  id,
  runId: crypto.randomUUID(),
  job: 'conformance.outbox',
  queue: 'conformance',
  input: { id, nested: { at: '2026-11-09' } },
  idempotencyKey: `conformance:${id}`,
  maxAttempts: 4,
  runAt: STAGED_AT + 1_000,
  stagedAt: STAGED_AT,
  tenantId: 'org-conformance',
  traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
  enqueuedBy: 'user-conformance',
  ...extra,
});

/** Stage `records` in one transaction that commits, and answer what `commit` reported. */
export async function committed(
  subject: OutboxStoreSubject,
  store: OutboxStore,
  records: readonly OutboxRecord[],
): Promise<readonly OutboxRecord[]> {
  const tx = await subject.transaction('commit', async (open) => {
    for (const record of records) await store.stage(open, record);
  });
  return store.commit(tx);
}

export const elapse = async (subject: OutboxStoreSubject, ms: number): Promise<void> => {
  await subject.elapse(ms);
};
