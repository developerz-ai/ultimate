// `ledger()` run by `executeJob` on the memory driver and the memory book: a balanced posting
// lands once however often it runs; an unbalanced, float, scale-mixed or one-legged one is refused
// TERMINALLY before any line is written.

import { afterEach, describe, expect, test } from 'bun:test';
import { ctxOf, isUltimateError, userActor } from '@ultimat3/core';
import type { ClaimedJob } from './driver';
import { memoryJobDriver } from './driver-memory';
import { executeJob } from './execute';
import type { AnyJobHandle } from './job';
import { resetJobs } from './job';
import type { LedgerEntry, LedgerPosting } from './ledger';
import { assertBalancedPosting, ledger } from './ledger';
import { memoryLedgerBook } from './ledger-book';

const eur = (minor: number) => ({ minor, currency: 'EUR' });
const usd = (minor: number) => ({ minor, currency: 'USD' });

afterEach(() => {
  resetJobs();
});

const run = async (handle: AnyJobHandle, posting: LedgerPosting, maxAttempts = 3) => {
  const driver = memoryJobDriver();
  await driver.enqueue({
    name: handle.name,
    queue: handle.queue,
    input: posting,
    idempotencyKey: `${handle.name}:${posting.key}`,
    maxAttempts,
  });
  const [claimed] = await driver.claim({
    queues: [handle.queue],
    limit: 1,
    visibilityTimeoutMs: 30_000,
    workerId: 'w1',
  });
  const ctx = ctxOf({ role: 'worker', actor: userActor({ id: 'worker-1' }) });
  return executeJob({ driver, claimed: claimed as ClaimedJob, handle, ctx });
};

const codeOf = (fn: () => void): string | undefined => {
  try {
    fn();
  } catch (error: unknown) {
    return isUltimateError(error) ? error.code : 'uncoded';
  }
  return undefined;
};

describe('ledger()', () => {
  test('a balanced posting is written once, however often it runs', async () => {
    const book = memoryLedgerBook();
    const post = ledger({ name: 'ledger-post', tenant: 'none', book: () => book });
    const posting: LedgerPosting = {
      key: 'pay_1',
      entries: [
        { account: 'cash', amount: eur(1299) },
        { account: 'revenue', amount: eur(-1099) },
        { account: 'vat', amount: eur(-200) },
      ],
    };
    const first = await run(post as AnyJobHandle, posting);
    expect(first.outcome).toBe('completed');
    expect(first.result).toEqual({ key: 'pay_1', lines: 3, written: 3 });
    const again = await run(post as AnyJobHandle, posting);
    expect(again.result).toEqual({ key: 'pay_1', lines: 3, written: 0 });
    expect(book.lines()).toHaveLength(3);
    expect(book.balance('cash', 'EUR')).toBe(1299);
    expect(book.balance('vat', 'EUR')).toBe(-200);
  });

  test('a key re-used with other entries is refused, the stored posting untouched', async () => {
    const book = memoryLedgerBook();
    const post = ledger({ name: 'ledger-reused', tenant: 'none', book: () => book });
    const first: LedgerPosting = {
      key: 'pay-1',
      entries: [
        { account: 'cash', amount: eur(1000) },
        { account: 'revenue', amount: eur(-1000) },
      ],
    };
    expect((await run(post as AnyJobHandle, first)).outcome).toBe('completed');
    // Balanced on its own, and a superset of the first: only line 2 would be new.
    const longer = await run(post as AnyJobHandle, {
      key: 'pay-1',
      entries: [
        ...first.entries,
        { account: 'vat', amount: eur(200) },
        { account: 'cash', amount: eur(-200) },
      ],
    });
    expect(longer.code).toBe('X_LEDGER_POSTING_CONFLICT');
    // Same count, another account on one line.
    const moved = await run(post as AnyJobHandle, {
      key: 'pay-1',
      entries: [first.entries[0] as LedgerEntry, { account: 'other', amount: eur(-1000) }],
    });
    expect(moved.code).toBe('X_LEDGER_POSTING_CONFLICT');
    expect(book.lines()).toHaveLength(2);
    expect(book.balance('cash', 'EUR') + book.balance('revenue', 'EUR')).toBe(0);
  });

  test('an unbalanced posting is refused terminally, nothing written', async () => {
    const book = memoryLedgerBook();
    const post = ledger({ name: 'ledger-unbalanced', tenant: 'none', book: () => book });
    const execution = await run(post as AnyJobHandle, {
      key: 'pay_2',
      entries: [
        { account: 'cash', amount: eur(1000) },
        { account: 'revenue', amount: eur(-999) },
      ],
    });
    expect(execution.code).toBe('X_LEDGER_UNBALANCED');
    expect(execution.attempt).toBe(1);
    expect(execution.stopReason).toBeDefined();
    expect(book.lines()).toHaveLength(0);
  });

  test('every currency nets to zero on its own: EUR and USD legs balance separately', () => {
    const fx = {
      key: 'fx_1',
      entries: [
        { account: 'eur-cash', amount: eur(-1000) },
        { account: 'fx', amount: eur(1000) },
        { account: 'fx', amount: usd(-1090) },
        { account: 'usd-cash', amount: usd(1090) },
      ],
    };
    expect(codeOf(() => assertBalancedPosting(fx))).toBeUndefined();
    // Netting across currencies is exactly what the per-currency sum refuses.
    const crossed = {
      key: 'fx_2',
      entries: [
        { account: 'eur-cash', amount: eur(-1000) },
        { account: 'usd-cash', amount: usd(1000) },
      ],
    };
    expect(codeOf(() => assertBalancedPosting(crossed))).toBe('X_LEDGER_UNBALANCED');
  });

  test.each([
    ['a float minor', { account: 'a', amount: eur(12.99) }],
    ['a currency that is not ISO 4217', { account: 'a', amount: { minor: 1, currency: 'eur' } }],
    ['an empty account', { account: ' ', amount: eur(1) }],
    ['a second scale in one currency', { account: 'a', amount: { ...eur(1), scale: 6 } }],
  ])('%s is X_LEDGER_ENTRY_INVALID', (_, entry) => {
    const posting = { key: 'p', entries: [{ account: 'b', amount: eur(-1) }, entry] };
    expect(codeOf(() => assertBalancedPosting(posting))).toBe('X_LEDGER_ENTRY_INVALID');
  });

  test('the input schema states what the posting check refuses, so a drawn sample can pass', async () => {
    const post = ledger({ name: 'ledger-schema', tenant: 'none', book: () => memoryLedgerBook() });
    const issues = async (value: unknown) => {
      const result = await post.input['~standard'].validate(value);
      return 'issues' in result && result.issues !== undefined ? result.issues.length : 0;
    };
    const legs = [
      { account: 'cash', amount: eur(1) },
      { account: 'revenue', amount: eur(-1) },
    ];
    expect(await issues({ key: 'p', entries: legs })).toBe(0);
    expect(await issues({ key: 'p', entries: legs.slice(0, 1) })).toBeGreaterThan(0);
    expect(await issues({ key: '', entries: legs })).toBeGreaterThan(0);
    expect(
      await issues({ key: 'p', entries: [{ account: '', amount: eur(1) }, legs[1]] }),
    ).toBeGreaterThan(0);
  });

  test('a one-legged posting is refused even at zero', () => {
    const posting = { key: 'p', entries: [{ account: 'a', amount: eur(0) }] };
    expect(codeOf(() => assertBalancedPosting(posting))).toBe('X_LEDGER_ENTRY_INVALID');
  });
});
