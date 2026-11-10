// `entityLedgerBook` over a TENANTED lines entity, run by `executeJob` under each posting's org: a
// key is one posting per tenant, so tenant B's `pay-1` is written beside tenant A's — never skipped
// as A's replay — and each tenant's lines carry its own org. Memory driver: tenancy and uniques
// are judged as Postgres judges them (`entityDriverConformance`).

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { ctxOf, userActor } from '@ultimat3/core';
import type { Driver } from '@ultimat3/entity';
import {
  clearRegistry,
  database,
  entity,
  integer,
  memoryDriver,
  money,
  text,
  uuid,
} from '@ultimat3/entity';
import type { ClaimedJob } from './driver';
import { memoryJobDriver } from './driver-memory';
import { executeJob } from './execute';
import type { AnyJobHandle } from './job';
import { resetJobs } from './job';
import type { LedgerPosting } from './ledger';
import { ledger } from './ledger';
import { entityLedgerBook } from './ledger-book';

const ORG_A = '00000000-0000-7000-8000-0000000000a1';
const ORG_B = '00000000-0000-7000-8000-0000000000b2';

const lines = entity('lt_lines', {
  columns: {
    orgId: uuid().tenant(),
    postingKey: text(),
    line: integer(),
    account: text(),
    amount: money(),
  },
  primaryKey: ['orgId', 'postingKey', 'line'],
});

afterEach(() => {
  resetJobs();
});
afterAll(() => {
  clearRegistry();
});

const run = async (handle: AnyJobHandle, posting: LedgerPosting) => {
  const driver = memoryJobDriver();
  await driver.enqueue({
    name: handle.name,
    queue: handle.queue,
    input: posting,
    idempotencyKey: posting.key,
    ...(posting.orgId === undefined ? {} : { tenantId: posting.orgId }),
    maxAttempts: 1,
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

const eur = (minor: number) => ({ minor, currency: 'EUR' });
const posting = (orgId: string, minor: number): LedgerPosting => ({
  key: 'pay-1',
  orgId,
  entries: [
    { account: 'cash', amount: eur(minor) },
    { account: 'revenue', amount: eur(-minor) },
  ],
});

describe('entityLedgerBook · a tenanted lines entity', () => {
  test('one key is one posting PER TENANT: B is written beside A, each under its own org', async () => {
    const rows: Driver = memoryDriver();
    const post = ledger({
      name: 'lt.post',
      tenant: (p) => p.orgId ?? 'none',
      book: () => entityLedgerBook({ driver: rows, entity: lines }),
    }) as AnyJobHandle;
    const a = await run(post, posting(ORG_A, 1000));
    expect(a.outcome).toBe('completed');
    const b = await run(post, posting(ORG_B, 700));
    expect(b.outcome).toBe('completed');
    expect(b.result).toEqual({ key: 'pay-1', lines: 2, written: 2 });
    // A's replay is still a replay, and still its own.
    expect((await run(post, posting(ORG_A, 1000))).result).toEqual({
      key: 'pay-1',
      lines: 2,
      written: 0,
    });
    const db = database({ lines }, { driver: rows });
    const of = async (orgId: string) =>
      (await db.lines.where({ orgId }).all()).map((row) => [row.account, row.amount.minor]);
    expect(await of(ORG_A)).toEqual([
      ['cash', 1000],
      ['revenue', -1000],
    ]);
    expect(await of(ORG_B)).toEqual([
      ['cash', 700],
      ['revenue', -700],
    ]);
  });

  test('a tenanted lines entity with no org on the posting is refused before any write', async () => {
    const rows: Driver = memoryDriver();
    const post = ledger({
      name: 'lt.untenanted',
      tenant: 'none',
      book: () => entityLedgerBook({ driver: rows, entity: lines }),
    }) as AnyJobHandle;
    const { orgId: _dropped, ...noOrg } = posting(ORG_A, 1000);
    const refused = await run(post, noOrg);
    expect(refused.code).toBe('X_LEDGER_ENTRY_INVALID');
  });
});
