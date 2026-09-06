// The in-app inbox: one row per (recipient, notification), with `seenAt` and `readAt`.
//
// SEEN and READ are two facts, exactly as `noticed` has them: seen is "the badge showed it", read
// is "they opened it". Collapsing them loses the only thing a badge can be derived from — and the
// count is DERIVED from `readAt is null`, never stored, because a stored counter and a row set
// drift the first time a write half-lands.

import { finiteCount } from '@ultimat3/core';

export interface InboxRow {
  /** Stable within a store. `(recipient, notifier, key)` is what makes it unique. */
  readonly id: string;
  readonly recipient: string;
  readonly notifier: string;
  readonly key: string;
  /** The notifier's validated params, as written. Denormalised on purpose: an inbox row records
   * what it said at the time, so deleting the thing it points at leaves the row readable. */
  readonly params: unknown;
  readonly createdAt: Date;
  readonly seenAt: Date | null;
  readonly readAt: Date | null;
}

export interface InboxQuery {
  readonly recipient: string;
  /** Bounded everywhere: an inbox is a page, never "everything since you signed up". */
  readonly limit?: number | undefined;
  /** `noticed`'s `unread` scope. Omitted reads the whole page. */
  readonly unreadOnly?: boolean | undefined;
}

export interface InboxWrite {
  readonly recipient: string;
  readonly notifier: string;
  readonly key: string;
  readonly params: unknown;
  readonly createdAt: Date;
}

export interface InboxStore {
  /**
   * Idempotent on `(recipient, notifier, key)`. Answers the row as it now stands, so a replay
   * gets the FIRST write's timestamps back rather than moving them — the same convergence rule
   * `markRead` follows, and what makes an at-least-once job safe to point at this store.
   */
  add(write: InboxWrite): Promise<InboxRow>;
  list(query: InboxQuery): Promise<readonly InboxRow[]>;
  unreadCount(recipient: string): Promise<number>;
  /** `noticed`'s `mark_as_read`, scoped: an id belonging to somebody else is simply absent. */
  markRead(input: { recipient: string; ids: readonly string[]; at: Date }): Promise<number>;
  /** Every unseen row for this recipient — what a rendered badge asserts. */
  markSeen(input: { recipient: string; at: Date }): Promise<number>;
}

export const DEFAULT_INBOX_PAGE = 50;

export interface MemoryInboxStore extends InboxStore {
  readonly size: number;
  clear(): void;
}

/** Codepoint order, never `localeCompare`: Postgres compares the tail key by bytes, not by locale. */
const compareText = (a: string, b: string): number => {
  if (a === b) return 0;
  return a < b ? -1 : 1;
};

/**
 * The tail key both stores order on: `(notifier, key)`, which is unique within a recipient because
 * `add` is idempotent on `(recipient, notifier, key)` and the Postgres table declares that UNIQUE.
 *
 * `id` cannot be it, and that is the whole reason this exists. `createPgInboxStore` mints a UUIDv7
 * and Postgres orders `uuid` by its 16 BYTES; `createMemoryInboxStore` derives its id from
 * `JSON.stringify([recipient, notifier, key])` and orders it by code point. Two total orders that
 * agree on nothing — so two notifications written in one millisecond came back in one order in dev
 * and the other in production, and a bounded page dropped one and repeated the other on exactly the
 * driver nobody was testing against. Two drivers behind one interface must not answer one question
 * two ways.
 */
const compareTail = (a: InboxRow, b: InboxRow): number =>
  compareText(a.notifier, b.notifier) || compareText(a.key, b.key);

const idOf = (write: { recipient: string; notifier: string; key: string }): string =>
  JSON.stringify([write.recipient, write.notifier, write.key]);

/**
 * The dev inbox: one process, no durability, unbounded. Unbounded deliberately and unlike the
 * memory ledger — a ledger that forgets a row starts sending duplicates, where an inbox that
 * forgets one just loses a message nobody was going to read after the restart anyway.
 */
export function createMemoryInboxStore(): MemoryInboxStore {
  const rows = new Map<string, InboxRow>();

  // `(createdAt desc, notifier, key)` — the same TOTAL order `SQL_NOTIFY_INBOX_PAGE` takes, and
  // for the same reason: `createdAt` alone is partial, so two notifications written in one
  // millisecond can swap places between two reads and a bounded page then drops one and repeats
  // the other.
  const own = (recipient: string): InboxRow[] =>
    [...rows.values()]
      .filter((row) => row.recipient === recipient)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || compareTail(a, b));

  return {
    get size(): number {
      return rows.size;
    },
    add(write) {
      const id = idOf(write);
      const existing = rows.get(id);
      if (existing !== undefined) return Promise.resolve(existing);
      const row: InboxRow = {
        id,
        recipient: write.recipient,
        notifier: write.notifier,
        key: write.key,
        params: write.params,
        createdAt: write.createdAt,
        seenAt: null,
        readAt: null,
      };
      rows.set(id, row);
      return Promise.resolve(row);
    },
    // `async` and not `Promise.resolve`, so a refused `limit` REJECTS here exactly as it does in
    // `createPgInboxStore`: two drivers behind one interface must not answer one question two ways,
    // and a sync throw against a rejected promise is a difference a caller can see.
    async list(query) {
      // `slice(0, NaN)` is `[]` — an empty inbox reported as the whole of it — and
      // `slice(0, Infinity)` is every row the recipient ever received, which is the unbounded read
      // `limit`'s own doc forbids. `??` reaches neither: `NaN` is not nullish.
      const limit = finiteCount(
        'createMemoryInboxStore',
        'limit',
        query.limit ?? DEFAULT_INBOX_PAGE,
        0,
      );
      return own(query.recipient)
        .filter((row) => query.unreadOnly !== true || row.readAt === null)
        .slice(0, limit);
    },
    unreadCount(recipient) {
      return Promise.resolve(own(recipient).filter((row) => row.readAt === null).length);
    },
    markRead(input) {
      let marked = 0;
      for (const id of input.ids) {
        const row = rows.get(id);
        // The recipient check is the SCOPE, not an optimisation: it is what makes an id somebody
        // else named simply absent, so no write can reach a row that is not the caller's own.
        if (row === undefined || row.recipient !== input.recipient || row.readAt !== null) continue;
        rows.set(id, { ...row, readAt: input.at });
        marked += 1;
      }
      return Promise.resolve(marked);
    },
    markSeen(input) {
      let marked = 0;
      for (const row of own(input.recipient)) {
        if (row.seenAt !== null) continue;
        rows.set(row.id, { ...row, seenAt: input.at });
        marked += 1;
      }
      return Promise.resolve(marked);
    },
    clear() {
      rows.clear();
    },
  };
}
