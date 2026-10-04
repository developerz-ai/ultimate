// `backfills.list({ runId })` on both ledgers: `x_backfills.run_id` is a uuid column, so a value
// that is not one was a raw `22P02` on Postgres and an empty list on the memory ledger — one
// question, two answers. Both refuse it now, before anything is read.

import { describe, expect, test } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import { isUltimateError } from '@ultimat3/core';
import { createMemoryBackfillLedger } from './backfill-ledger';
import { createPgDriver } from './driver-pg';

const RUN_ID = '019ff1c5-0000-7000-8000-00000000beef';

function recording(): { readonly executor: PgExecutor; readonly sql: string[] } {
  const sql: string[] = [];
  return {
    sql,
    executor: {
      query<R>(text: string): Promise<readonly R[]> {
        sql.push(text);
        return Promise.resolve([] as readonly R[]);
      },
    },
  };
}

const refusal = async (attempt: Promise<unknown>): Promise<{ code: string; cause: string }> => {
  try {
    await attempt;
  } catch (error) {
    if (isUltimateError(error)) return { code: error.code, cause: String(error.cause) };
  }
  return expect.unreachable('expected a refusal');
};

// The cast is the test: the value arrives from a URL, a flag or an MCP argument.
const BAD: readonly unknown[] = ['x', 'order-42', '', RUN_ID.toUpperCase(), `${RUN_ID}0`, 42, null];

describe('a ledger list filtered by a run id that is not a uuid', () => {
  test('the memory ledger refuses it with X_ID_INVALID, never an empty page', async () => {
    const ledger = createMemoryBackfillLedger();
    for (const runId of BAD) {
      const refused = await refusal(ledger.list({ runId: runId as string }));
      expect(refused.code).toBe('X_ID_INVALID');
      expect(refused.cause).toContain('backfills.list');
    }
  });

  test('the pg ledger refuses the same values BEFORE it issues a statement', async () => {
    const { executor, sql } = recording();
    const ledger = createPgDriver({ executor }).backfills;
    if (ledger === undefined) return expect.unreachable('the pg driver ships a ledger');
    for (const runId of BAD) {
      const refused = await refusal(ledger.list({ runId: runId as string }));
      expect(refused.code).toBe('X_ID_INVALID');
    }
    expect(sql).toEqual([]);
  });

  test('what was typed is described, never echoed: a mistyped id is as often a secret', async () => {
    const refused = await refusal(createMemoryBackfillLedger().list({ runId: 'sk_live_abc' }));
    expect(refused.cause).not.toContain('sk_live_abc');
  });

  test('a uuid, and no run id at all, are read as before — on both', async () => {
    const memory = createMemoryBackfillLedger();
    expect(await memory.list({ runId: RUN_ID })).toEqual([]);
    expect(await memory.list()).toEqual([]);
    const { executor, sql } = recording();
    const pg = createPgDriver({ executor }).backfills;
    expect(await pg?.list({ runId: RUN_ID })).toEqual([]);
    expect(await pg?.list({})).toEqual([]);
    expect(sql).toHaveLength(2);
  });
});
