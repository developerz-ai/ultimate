// The ONE contract every `ErrorGroupsStore` is held to — the memory twin in `error-groups.test.ts`,
// Postgres in `error-groups-pg.contract.test.ts` and `error-groups.live.test.ts`. A case is written
// once here, so the two stores cannot drift into two answers for one question.

import { expect } from 'bun:test';
import type { ErrorGroupOccurrence, ErrorGroupsStore } from './error-groups-store';

export const occurrence = (
  over: Partial<ErrorGroupOccurrence> & { readonly fingerprint: string },
): ErrorGroupOccurrence => ({
  // A registered code: a fixture is shipped-source-shaped, and `error-catalog.test.ts` reads every
  // X_* literal in one against the registry.
  code: 'X_INTERNAL',
  source: 'http',
  operation: 'POST /orders',
  message: 'order o_1 is stuck',
  at: new Date('2026-11-06T10:00:00.000Z'),
  count: 1,
  sample: {
    at: '2026-11-06T10:00:00.000Z',
    severity: 'error',
    title: 'an order is stuck',
    cause: 'order o_1 is stuck',
    fix: 'x jobs show orders --json',
    release: 'build-1',
    environment: 'production',
    requestId: 'req-1',
    traceId: null,
    meta: { orderId: 'o_1' },
    stack: null,
  },
  ...over,
});

/** Each case gets a fresh store and a fingerprint prefix no other case shares. */
export const STORE_CASES: readonly {
  readonly name: string;
  readonly run: (store: ErrorGroupsStore, prefix: string) => Promise<void>;
}[] = [
  {
    name: 'the first occurrence is new, the second is not, and the count adds',
    run: async (store, prefix) => {
      const fingerprint = `${prefix}a`;
      expect((await store.record(occurrence({ fingerprint }))).isNew).toBe(true);
      const later = new Date('2026-11-06T10:05:00.000Z');
      expect((await store.record(occurrence({ fingerprint, at: later, count: 3 }))).isNew).toBe(
        false,
      );
      const group = await store.get(fingerprint);
      expect(group?.count).toBe(4);
      expect(group?.firstSeen).toBe('2026-11-06T10:00:00.000Z');
      expect(group?.lastSeen).toBe(later.toISOString());
      expect(group?.status).toBe('open');
      expect(group?.sample.meta).toEqual({ orderId: 'o_1' });
    },
  },
  {
    name: 'a late, older occurrence never moves last seen backwards',
    run: async (store, prefix) => {
      const fingerprint = `${prefix}b`;
      await store.record(occurrence({ fingerprint, at: new Date('2026-11-06T11:00:00.000Z') }));
      await store.record(occurrence({ fingerprint, at: new Date('2026-11-06T09:00:00.000Z') }));
      expect((await store.get(fingerprint))?.lastSeen).toBe('2026-11-06T11:00:00.000Z');
    },
  },
  {
    name: 'resolved re-opens on the next occurrence; ignored stays ignored',
    run: async (store, prefix) => {
      await store.record(occurrence({ fingerprint: `${prefix}r` }));
      await store.record(occurrence({ fingerprint: `${prefix}i` }));
      expect((await store.setStatus(`${prefix}r`, 'resolved'))?.status).toBe('resolved');
      await store.setStatus(`${prefix}i`, 'ignored');
      await store.record(occurrence({ fingerprint: `${prefix}r` }));
      await store.record(occurrence({ fingerprint: `${prefix}i` }));
      expect((await store.get(`${prefix}r`))?.status).toBe('open');
      expect((await store.get(`${prefix}i`))?.status).toBe('ignored');
      expect(await store.setStatus(`${prefix}missing`, 'resolved')).toBeUndefined();
    },
  },
  {
    name: 'list is newest-seen first, filtered by status, bounded by limit',
    run: async (store, prefix) => {
      for (const [index, hour] of ['01', '03', '02'].entries()) {
        await store.record(
          occurrence({
            fingerprint: `${prefix}${index}`,
            at: new Date(`2030-01-01T${hour}:00:00.000Z`),
          }),
        );
      }
      await store.setStatus(`${prefix}2`, 'ignored');
      const mine = (await store.list({ limit: 500 })).filter((group) =>
        group.fingerprint.startsWith(prefix),
      );
      expect(mine.map((group) => group.fingerprint)).toEqual([
        `${prefix}1`,
        `${prefix}2`,
        `${prefix}0`,
      ]);
      const ignored = (await store.list({ status: 'ignored' })).filter((group) =>
        group.fingerprint.startsWith(prefix),
      );
      expect(ignored.map((group) => group.fingerprint)).toEqual([`${prefix}2`]);
      expect(await store.list({ limit: 1 })).toHaveLength(1);
      await expect(store.list({ limit: Number.NaN })).rejects.toThrow('limit');
    },
  },
  {
    name: 'purge removes exactly the groups last seen before the bound',
    run: async (store, prefix) => {
      await store.record(occurrence({ fingerprint: `${prefix}old`, at: new Date('2000-01-01') }));
      await store.record(occurrence({ fingerprint: `${prefix}new`, at: new Date('2099-01-01') }));
      expect(await store.purge(Date.parse('2000-06-01'))).toBeGreaterThanOrEqual(1);
      expect(await store.get(`${prefix}old`)).toBeUndefined();
      expect(await store.get(`${prefix}new`)).toBeDefined();
    },
  },
];
