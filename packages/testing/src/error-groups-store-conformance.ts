// The `ErrorGroupsStore` contract of `@ultimat3/admin` as shared examples, for a store of your own:
// `behavesLike(errorGroupsStoreConformance, () => store)`. Structural, because `admin` is this
// package's tier and a sideways import is refused: an `ErrorGroupsStore` is assignable to the
// `ErrorGroupsStoreLike` below. Each check writes under its own fingerprint prefix, so a shared table is fine.

import { expect, test } from 'bun:test';
import type { SharedExamples } from './shared-examples';
import { sharedExamples } from './shared-examples';

type Maybe<T> = T | Promise<T>;

export type ErrorGroupStatusLike = 'open' | 'resolved' | 'ignored';

/** `@ultimat3/admin`'s `ErrorGroupOccurrence`, structurally. */
export interface ErrorGroupOccurrenceLike {
  readonly fingerprint: string;
  readonly code: string;
  readonly source: string;
  readonly operation: string | null;
  readonly message: string;
  readonly at: Date;
  readonly count: number;
  readonly sample: {
    readonly at: string;
    readonly severity: string;
    readonly title: string;
    readonly cause: string;
    readonly fix: string;
    readonly release: string | null;
    readonly environment: string;
    readonly requestId: string | null;
    readonly traceId: string | null;
    readonly meta: Readonly<Record<string, unknown>> | null;
    readonly stack: string | null;
  };
}

export interface ErrorGroupLike {
  readonly fingerprint: string;
  readonly code: string;
  readonly status: ErrorGroupStatusLike;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly count: number;
  readonly sample: ErrorGroupOccurrenceLike['sample'];
}

/** The five members of `@ultimat3/admin`'s `ErrorGroupsStore`, structurally. */
export interface ErrorGroupsStoreLike {
  record(occurrence: ErrorGroupOccurrenceLike): Promise<{ readonly isNew: boolean }>;
  list(query?: {
    readonly status?: ErrorGroupStatusLike | undefined;
    readonly limit?: number | undefined;
  }): Promise<readonly ErrorGroupLike[]>;
  get(fingerprint: string): Promise<ErrorGroupLike | undefined>;
  setStatus(fingerprint: string, status: ErrorGroupStatusLike): Promise<ErrorGroupLike | undefined>;
  purge(beforeMs: number): Promise<number>;
}

export interface ErrorGroupsStoreCheck {
  readonly name: string;
  run(store: ErrorGroupsStoreLike, prefix: string): Promise<void>;
}

const occurrence = (
  over: Partial<ErrorGroupOccurrenceLike> & { readonly fingerprint: string },
): ErrorGroupOccurrenceLike => ({
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

const RACERS = 5;

export const ERROR_GROUPS_STORE_CHECKS: readonly ErrorGroupsStoreCheck[] = [
  {
    name: 'the first occurrence is new, the second is not, and the count adds',
    async run(store, prefix) {
      const fingerprint = `${prefix}a`;
      expect((await store.record(occurrence({ fingerprint }))).isNew).toBe(true);
      const later = new Date('2026-11-06T10:05:00.000Z');
      const second = await store.record(occurrence({ fingerprint, at: later, count: 3 }));
      expect(second.isNew).toBe(false);
      const group = await store.get(fingerprint);
      expect(group).toMatchObject({
        count: 4,
        firstSeen: '2026-11-06T10:00:00.000Z',
        lastSeen: later.toISOString(),
        status: 'open',
      });
      expect(group?.sample.meta).toEqual({ orderId: 'o_1' });
    },
  },
  {
    name: `${RACERS} racing records of one new group: one isNew, every count kept`,
    async run(store, prefix) {
      const fingerprint = `${prefix}race`;
      const answers = await Promise.all(
        Array.from({ length: RACERS }, () => store.record(occurrence({ fingerprint }))),
      );
      expect(answers.filter((answer) => answer.isNew)).toHaveLength(1);
      expect((await store.get(fingerprint))?.count).toBe(RACERS);
    },
  },
  {
    name: 'a late, older occurrence never moves last seen backwards',
    async run(store, prefix) {
      const fingerprint = `${prefix}b`;
      await store.record(occurrence({ fingerprint, at: new Date('2026-11-06T11:00:00.000Z') }));
      await store.record(occurrence({ fingerprint, at: new Date('2026-11-06T09:00:00.000Z') }));
      expect((await store.get(fingerprint))?.lastSeen).toBe('2026-11-06T11:00:00.000Z');
    },
  },
  {
    name: 'resolved re-opens on the next occurrence; ignored stays ignored',
    async run(store, prefix) {
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
    async run(store, prefix) {
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
    async run(store, prefix) {
      await store.record(occurrence({ fingerprint: `${prefix}old`, at: new Date('2000-01-01') }));
      await store.record(occurrence({ fingerprint: `${prefix}new`, at: new Date('2099-01-01') }));
      expect(await store.purge(Date.parse('2000-06-01'))).toBeGreaterThanOrEqual(1);
      expect(await store.get(`${prefix}old`)).toBeUndefined();
      expect(await store.get(`${prefix}new`)).toBeDefined();
    },
  },
];

let minted = 0;
const prefixOf = (): string => {
  minted += 1;
  return `conformance-${process.pid.toString(36)}-${minted.toString(36)}-`;
};

export const errorGroupsStoreConformance: SharedExamples<Maybe<ErrorGroupsStoreLike>> =
  sharedExamples('an error-groups store', (subject) => {
    for (const check of ERROR_GROUPS_STORE_CHECKS) {
      test(check.name, async () => {
        await check.run(await subject(), prefixOf());
      });
    }
  });
