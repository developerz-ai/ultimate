// Single responsibility: where push subscriptions live — the seam, and the in-memory store a test
// or a single process uses. The Postgres store is `push-store-pg.ts`.
//
// A subscription is keyed by its ENDPOINT, never by (actor, endpoint): one browser profile holds
// one subscription, and when a second person signs in on that browser and subscribes, the
// subscription is theirs now. Keyed by the pair, the first person would go on receiving the second
// person's notifications on a device they no longer use.

import type { PushSubscriptionRecord } from './push';

export interface PushSubscriptionStore {
  /** Insert, or hand an existing endpoint to this record's actor with its new keys and locale. */
  save(record: PushSubscriptionRecord): Promise<void>;
  /** Every subscription of one actor, ordered by endpoint (code point) — one order in both stores. */
  listFor(actorId: string): Promise<readonly PushSubscriptionRecord[]>;
  /**
   * Delete one endpoint. With `actorId`, only when it is that actor's — an unsubscribe names its
   * owner, so an endpoint somebody else holds is simply absent. Without, unconditionally — the
   * sender's answer to a 404/410, which says the endpoint is dead whoever held it.
   */
  remove(endpoint: string, actorId?: string): Promise<boolean>;
}

const byEndpoint = (a: PushSubscriptionRecord, b: PushSubscriptionRecord): number =>
  a.endpoint < b.endpoint ? -1 : a.endpoint > b.endpoint ? 1 : 0;

/** One process's subscriptions. Lost on restart, which is the right fate for a test's. */
export function memoryPushSubscriptionStore(): PushSubscriptionStore {
  const rows = new Map<string, PushSubscriptionRecord>();
  return {
    save(record) {
      const existing = rows.get(record.endpoint);
      // The first `createdAt` survives a re-subscribe, as `on conflict do update` leaves it.
      rows.set(
        record.endpoint,
        existing === undefined ? record : { ...record, createdAt: existing.createdAt },
      );
      return Promise.resolve();
    },
    listFor(actorId) {
      return Promise.resolve(
        [...rows.values()].filter((row) => row.actorId === actorId).sort(byEndpoint),
      );
    },
    remove(endpoint, actorId) {
      const row = rows.get(endpoint);
      if (row === undefined || (actorId !== undefined && row.actorId !== actorId)) {
        return Promise.resolve(false);
      }
      rows.delete(endpoint);
      return Promise.resolve(true);
    },
  };
}
