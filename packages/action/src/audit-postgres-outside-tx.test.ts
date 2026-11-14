// Group commit sends every batch outside any ambient transaction: the timer that sends it, and a
// full batch sent inline, both run in the async context of whichever write ARMED them, so a batch
// carrying other callers' records would otherwise be written on that write's transaction.

import { afterAll, describe, expect, test } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import { ctxOf, userActor } from '@ultimat3/core';
import { currentTx, pgliteClient, setDbClient, withTransaction } from '@ultimat3/db';
import type { AuditRecord } from './audit';
import { postgresAuditSink } from './audit-postgres';

const client = pgliteClient();
setDbClient(client);

afterAll(async () => {
  setDbClient(undefined);
  await client.close();
});

const record = (name: string): AuditRecord => ({
  at: new Date(1_700_000_000_000),
  name,
  primitive: 'action',
  mutator: true,
  surface: 'http',
  ctx: ctxOf({ actor: userActor({ id: 'u1' }) }),
  input: null,
  idempotencyKey: null,
  replayed: false,
  outcome: 'allowed',
  failure: null,
});

/** Records, per statement, whether it was sent with a transaction on the async context. */
function observing(refuseMany = false): { exec: PgExecutor; inTx: boolean[] } {
  const inTx: boolean[] = [];
  const exec: PgExecutor = {
    query<R>(text: string): Promise<readonly R[]> {
      inTx.push(currentTx() !== undefined);
      if (refuseMany && text.includes('jsonb_to_recordset')) {
        return Promise.reject(new RangeError('batch refused'));
      }
      return Promise.resolve([] as unknown as readonly R[]);
    },
  };
  return { exec, inTx };
}

describe('postgresAuditSink · groupCommit sends outside the arming transaction', () => {
  test('a batch armed inside a transaction is sent with no transaction on its context', async () => {
    const { exec, inTx } = observing();
    const sink = postgresAuditSink({ executor: exec, groupCommit: { maxDelayMs: 0 } });
    try {
      await withTransaction(async () => {
        const mine = sink.write(record('armedInTx'));
        const theirs = sink.write(record('someoneElse'));
        await Promise.all([mine, theirs]);
      });
    } finally {
      await sink.close();
    }
    expect(inTx).toEqual([false]);
  });

  test('a full batch sent inline from inside a transaction is outside it too', async () => {
    const { exec, inTx } = observing();
    const sink = postgresAuditSink({ executor: exec, groupCommit: { maxRecords: 1 } });
    try {
      await withTransaction(() => sink.write(record('fullAtOnce')));
    } finally {
      await sink.close();
    }
    expect(inTx).toEqual([false]);
  });

  test('the one-by-one retry of a refused batch is outside it too', async () => {
    const { exec, inTx } = observing(true);
    const sink = postgresAuditSink({ executor: exec, groupCommit: { maxDelayMs: 0 } });
    try {
      await withTransaction(() =>
        Promise.all([sink.write(record('retryA')), sink.write(record('retryB'))]),
      );
    } finally {
      await sink.close();
    }
    expect(inTx).toEqual([false, false, false]);
  });

  test('without groupCommit a write still joins the caller’s transaction, as it always has', async () => {
    const { exec, inTx } = observing();
    await withTransaction(() => postgresAuditSink({ executor: exec }).write(record('joins')));
    expect(inTx).toEqual([true]);
  });
});
