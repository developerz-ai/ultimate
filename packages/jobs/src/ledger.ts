// `ledger()`: double-entry postings as a FACTORY over `job()`, never a ninth primitive. A posting
// is balanced Money entries under one key; the job refuses an unbalanced or float posting before a
// line is written, then writes every line in ONE durable step through the app's `LedgerBook` —
// idempotent by `(key, line)`, so a retry, a replay or a second enqueue of one key posts it once.

import type { MoneyValue, StandardSchemaV1 } from '@ultimat3/schema';
import { isCurrencyCode, isMoneyScale, t } from '@ultimat3/schema';
import type { DurationInput } from './clock';
import type { JobHandle } from './job';
import { job } from './job';
import type { LedgerBook, LedgerLine } from './ledger-book';
import { LedgerEntryInvalidError, LedgerUnbalancedError } from './ledger-errors';
import type { RetryPolicy } from './retry';
import { DEFAULT_RETRY } from './retry';
import type { JobTenant } from './tenant';

/** One leg: an account the app names and a signed amount. Debit or credit is the sign's, not ours. */
export interface LedgerEntry {
  readonly account: string;
  readonly amount: MoneyValue;
}

/** What the job is enqueued with. `key` is the posting's identity — a payment id, a transfer id. */
export interface LedgerPosting {
  readonly key: string;
  readonly entries: readonly LedgerEntry[];
  /** The tenant the posting belongs to, read by `tenant: (p) => p.orgId ?? …` when the app has one. */
  readonly orgId?: string | undefined;
}

export interface LedgerDefinition {
  /** REQUIRED: a durable key — the queue row and the idempotency key carry it. */
  readonly name: string;
  readonly tenant: JobTenant<LedgerPosting>;
  /** Where lines land — a thunk, read per run (`entityLedgerBook`, or the app's own). */
  readonly book: () => LedgerBook;
  readonly queue?: string;
  readonly retry?: RetryPolicy;
  readonly timeout?: DurationInput;
}

/** What one run answers: the lines the posting has, and how many THIS run wrote. */
export interface LedgerReport {
  readonly key: string;
  readonly lines: number;
  readonly written: number;
}

/** A posting's legs: at least two, since one entry can only balance at zero, which moves nothing. */
export const MIN_LEDGER_ENTRIES = 2;

/**
 * Every rule `assertBalancedPosting` can say without adding anything up: a key, at least
 * `MIN_LEDGER_ENTRIES` legs, a named account, a Money amount. Stated in the schema so a sample an
 * exercise pass or a client draws from it is a posting the run could accept — only the per-currency
 * sum, which no schema can express, is left to the run.
 */
const postingSchema: StandardSchemaV1<unknown, LedgerPosting> = t.object({
  key: t.string.min(1),
  entries: t.array(t.object({ account: t.string.min(1), amount: t.money }), {
    min: MIN_LEDGER_ENTRIES,
  }),
  orgId: t.string.optional(),
});

function assertEntry(key: string, entry: LedgerEntry, index: number): void {
  const refuse = (field: string, got: unknown): never => {
    throw new LedgerEntryInvalidError({ key, index, field, got });
  };
  if (typeof entry.account !== 'string' || entry.account.trim() === '') {
    refuse('account', entry.account);
  }
  const { minor, currency, scale } = entry.amount;
  if (!Number.isSafeInteger(minor)) refuse('amount.minor', minor);
  if (!isCurrencyCode(currency)) refuse('amount.currency', currency);
  if (scale !== undefined && !isMoneyScale(scale)) refuse('amount.scale', scale);
}

/**
 * Refuse a posting that is not balanced Money, before anything is written. Exported so the action
 * that enqueues one refuses it at the request — the job refuses it again, since a queue row is input.
 * Within one currency every entry carries the same `scale`: a sum across two scales is not a sum.
 */
export function assertBalancedPosting(posting: LedgerPosting): void {
  const { key } = posting;
  if (typeof key !== 'string' || key === '') {
    throw new LedgerEntryInvalidError({ key: String(key), index: null, field: 'key', got: key });
  }
  if (posting.entries.length < MIN_LEDGER_ENTRIES) {
    throw new LedgerEntryInvalidError({
      key,
      index: null,
      field: 'entries.length',
      got: posting.entries.length,
    });
  }
  const sums = new Map<string, { net: number; scale: number | undefined }>();
  posting.entries.forEach((entry, index) => {
    assertEntry(key, entry, index);
    const { minor, currency, scale } = entry.amount;
    const seen = sums.get(currency);
    if (seen !== undefined && seen.scale !== scale) {
      throw new LedgerEntryInvalidError({ key, index, field: 'amount.scale', got: scale });
    }
    const net = (seen?.net ?? 0) + minor;
    // Safe integers summed past 2^53 stop being exact: refused rather than rounded.
    if (!Number.isSafeInteger(net)) {
      throw new LedgerEntryInvalidError({ key, index, field: 'amount.minor', got: minor });
    }
    sums.set(currency, { net, scale });
  });
  for (const [currency, { net }] of [...sums].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (net !== 0) throw new LedgerUnbalancedError({ key, currency, net });
  }
}

/** The posting as the lines a book stores: one per entry, numbered from 0 in the posting's order. */
export const ledgerLines = (posting: LedgerPosting): readonly LedgerLine[] =>
  posting.entries.map((entry, line) => ({
    ...(posting.orgId === undefined ? {} : { tenant: posting.orgId }),
    postingKey: posting.key,
    line,
    account: entry.account,
    amount: entry.amount,
  }));

export function ledger(definition: LedgerDefinition): JobHandle<LedgerPosting> {
  return job<LedgerPosting>({
    name: definition.name,
    input: postingSchema,
    tenant: definition.tenant,
    // One live run per posting; the book's `(postingKey, line)` holds it after the run is gone.
    idempotencyKey: (posting) => `${definition.name}:${posting.key}`,
    retry: definition.retry ?? DEFAULT_RETRY,
    ...(definition.queue === undefined ? {} : { queue: definition.queue }),
    ...(definition.timeout === undefined ? {} : { timeout: definition.timeout }),
    run: async ({ step, input }): Promise<LedgerReport> => {
      assertBalancedPosting(input);
      const lines = ledgerLines(input);
      // ONE step: every line or none, and a replay answers the persisted count without a write.
      const written = await step.run('post', () => definition.book().write(lines));
      return { key: input.key, lines: lines.length, written };
    },
  });
}
