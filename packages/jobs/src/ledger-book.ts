// Where `ledger()` writes: the `LedgerBook` seam, the memory book a test reads, and the book over an
// app's own entity. The TABLE is the app's (axiom 8: its accounts, its retention, its tenancy); the
// mechanism is one idempotent statement keyed by `(postingKey, line)`, so a replay writes nothing.

import type { Driver, EntityCore, RowWrite } from '@ultimat3/entity';
import type { MoneyValue } from '@ultimat3/schema';
import { LedgerEntryInvalidError, LedgerPostingConflictError } from './ledger-errors';

/** One stored leg. `(tenant, postingKey, line)` is unique: the identity a replay lands on. */
export interface LedgerLine {
  /** The posting's `orgId`: a key names one posting PER TENANT. Absent for an untenanted book. */
  readonly tenant?: string | undefined;
  readonly postingKey: string;
  readonly line: number;
  readonly account: string;
  readonly amount: MoneyValue;
}

export interface LedgerBook {
  /**
   * Store one posting's lines, all or none, and answer how many THIS call wrote: every line, or
   * `0` when the key is already stored with exactly these lines. A key stored with any other lines
   * — another count, another line — is `X_LEDGER_POSTING_CONFLICT`, and nothing is written: the
   * new lines beside the stored ones would unbalance the book. Atomic: never half a posting.
   */
  write(lines: readonly LedgerLine[]): Promise<number>;
}

const sameAmount = (a: MoneyValue, b: MoneyValue): boolean =>
  a.minor === b.minor && a.currency === b.currency && (a.scale ?? null) === (b.scale ?? null);

/**
 * Refuse unless `stored` (the key's lines in the book) are exactly `incoming`. `fresh` is how many
 * of `incoming` this write itself inserted: all of them is a new posting, none a replay — any
 * other number means part of the key was already there, which is a conflict whatever it now reads.
 */
export function assertSamePosting(
  incoming: readonly LedgerLine[],
  stored: readonly Pick<LedgerLine, 'line' | 'account' | 'amount'>[],
  fresh: number,
): void {
  const key = incoming[0]?.postingKey ?? '';
  const conflict = (line: number | null): never => {
    throw new LedgerPostingConflictError({
      key,
      stored: stored.length - fresh,
      incoming: incoming.length,
      line,
    });
  };
  if ((fresh !== 0 && fresh !== incoming.length) || stored.length !== incoming.length) {
    conflict(null);
  }
  const byLine = new Map(stored.map((row) => [row.line, row]));
  for (const line of incoming) {
    const held = byLine.get(line.line);
    if (
      held === undefined ||
      held.account !== line.account ||
      !sameAmount(held.amount, line.amount)
    ) {
      conflict(line.line);
    }
  }
}

/** The memory book, plus what a test reads back. */
export interface MemoryLedgerBook extends LedgerBook {
  lines(): readonly LedgerLine[];
  /** One account's balance in one currency, in minor units. */
  balance(account: string, currency: string): number;
}

const lineKey = (line: Pick<LedgerLine, 'tenant' | 'postingKey' | 'line'>): string =>
  `${line.tenant ?? ''}\u0000${line.postingKey}\u0000${line.line}`;

/** Which posting a line belongs to: one per (tenant, key). A posting id, not a credential. */
const postingOf = (line: Pick<LedgerLine, 'tenant' | 'postingKey'>): string =>
  `${line.tenant ?? ''}\u0000${line.postingKey}`;

export function memoryLedgerBook(): MemoryLedgerBook {
  const stored = new Map<string, LedgerLine>();
  return {
    async write(lines) {
      const first = lines[0];
      const posting = first === undefined ? undefined : postingOf(first);
      const held = [...stored.values()].filter((line) => postingOf(line) === posting);
      // Judged before any write: a refused posting leaves the book as it was.
      if (held.length > 0) {
        assertSamePosting(lines, held, 0);
        return 0;
      }
      for (const line of lines) stored.set(lineKey(line), line);
      return lines.length;
    },
    lines: () => [...stored.values()],
    balance: (account, currency) =>
      [...stored.values()]
        .filter((line) => line.account === account && line.amount.currency === currency)
        .reduce((net, line) => net + line.amount.minor, 0),
  };
}

export interface EntityLedgerBookOptions<Row extends LedgerLine> {
  /** The driver the app's `database()` reads through, so tenancy and row observers hold. */
  readonly driver: Driver;
  /**
   * The app's lines entity: `postingKey` text, `line` integer, `account` text, `amount` money, a
   * UNIQUE index (or the primary key) on `(postingKey, line)` — on `(<tenant>, postingKey, line)`
   * when the entity has a tenant column, which the posting's `orgId` fills — and whatever else it
   * keeps defaulted. Without that unique Postgres refuses the statement (`42P10`).
   */
  readonly entity: EntityCore<Row>;
}

/**
 * The book over an app entity: in ONE transaction, `insert … on conflict do nothing`, then the
 * key's stored lines read back and judged (`assertSamePosting`) — a refusal rolls this write's
 * lines back, and a concurrent write of the same key with other lines waits on the first's rows,
 * then meets them committed and is refused.
 */
export function entityLedgerBook<Row extends LedgerLine>(
  options: EntityLedgerBookOptions<Row>,
): LedgerBook {
  return {
    write(lines) {
      const tenant = options.entity.$tenantColumn;
      const first = lines[0];
      // A tenanted book holds one posting per (tenant, key): the org is the row's, never inferred.
      if (tenant !== null && (first === undefined || first.tenant === undefined)) {
        throw new LedgerEntryInvalidError({
          key: first?.postingKey ?? '',
          index: null,
          field: 'orgId',
          got: first?.tenant,
        });
      }
      const scope: Record<string, unknown> = tenant === null ? {} : { [tenant]: first?.tenant };
      // The lines ARE rows of `Row` minus its defaulted columns, which the statement fills.
      const rows = lines.map(({ tenant: _, ...line }) => ({
        ...scope,
        ...line,
      })) as unknown as readonly RowWrite<Row>[];
      const target = (
        tenant === null ? ['postingKey', 'line'] : [tenant, 'postingKey', 'line']
      ) as (keyof Row & string)[];
      const repo = options.driver.repo(options.entity);
      return options.driver.transactor().run(async (tx) => {
        const written = await repo.upsertAll(rows, { onConflict: target, onMatch: 'nothing', tx });
        const held = await repo.findMany({
          // The tenant named, not left to the run's scope: outside a job no scope exists, and an
          // unscoped tenanted read is refused (`X_TENANCY_UNSCOPED`).
          where: [
            { column: 'postingKey', op: 'eq', value: first?.postingKey },
            ...(tenant === null
              ? []
              : [{ column: tenant, op: 'eq' as const, value: first?.tenant }]),
          ],
          // One past what a match holds: a longer stored posting is seen as longer, never cut.
          limit: lines.length + 1,
          tx,
        });
        assertSamePosting(lines, held.rows, written.length);
        return written.length;
      });
    },
  };
}
