// `pgEnqueueMany`'s control flow over a scripted executor: one insert for the batch, one read for
// the rows it skipped, and `enqueue` for a row neither statement answers. The statements' meaning
// on a real Postgres is `enqueue-many.job.test.ts`; this pins what the driver does with the rows.

import { describe, expect, test } from 'bun:test';
import type { PgExecutor, UltimateError } from '@ultimat3/core';
import { frozenClock } from '@ultimat3/core';
import type { EnqueueRequest } from './driver';
import {
  pgEnqueueMany,
  SQL_ENQUEUE_MANY,
  SQL_ENQUEUE_MANY_RESOLVE,
} from './driver-pg-enqueue-many';

const clock = frozenClock('2026-11-03T00:00:00.000Z');

const request = (key: string, extra: Partial<EnqueueRequest> = {}): EnqueueRequest => ({
  id: `0190a000-0000-7000-8000-00000000000${key.length}`,
  name: 'job',
  queue: '',
  input: undefined,
  idempotencyKey: key,
  maxAttempts: 1,
  ...extra,
});

/** Answers each statement from `answers` in order, recording what was sent with what. */
const scripted = (answers: readonly (readonly unknown[])[]) => {
  const sent: { sql: string; params: readonly unknown[] }[] = [];
  let next = 0;
  const executor: PgExecutor = {
    query: <R>(sql: string, params: readonly unknown[]) => {
      sent.push({ sql, params });
      const rows = answers[next] ?? [];
      next += 1;
      return Promise.resolve(rows as readonly R[]);
    },
  };
  return { exec: () => executor, sent };
};

const unused = () => expect.unreachable('enqueue was not needed');

describe('pgEnqueueMany', () => {
  test('an empty batch sends nothing', async () => {
    const { exec, sent } = scripted([]);
    expect(await pgEnqueueMany(exec, clock, [], unused)).toEqual([]);
    expect(sent).toEqual([]);
  });

  test('every row inserted: one statement, the defaults filled in on the wire', async () => {
    const one = request('a');
    const { exec, sent } = scripted([[{ id: one.id, run_id: 'run-a' }]]);
    expect(await pgEnqueueMany(exec, clock, [one], unused)).toEqual([
      { id: one.id ?? '', runId: 'run-a', deduped: false },
    ]);
    expect(sent.map((call) => call.sql)).toEqual([SQL_ENQUEUE_MANY]);
    const [wire] = JSON.parse(String(sent[0]?.params[0])) as Record<string, unknown>[];
    expect(wire).toMatchObject({ queue: 'default', input: null, runAt: clock.now().getTime() });
    expect(typeof wire?.['runId']).toBe('string');
  });

  test('a skipped row is answered by the resolve read, deduped, in request order', async () => {
    const first = request('a');
    const second = request('bb');
    const { exec, sent } = scripted([
      [{ id: first.id, run_id: 'run-a' }],
      [{ ord: '1', id: 'held', run_id: 'run-held' }],
    ]);
    expect(await pgEnqueueMany(exec, clock, [first, second], unused)).toEqual([
      { id: first.id ?? '', runId: 'run-a', deduped: false },
      { id: 'held', runId: 'run-held', deduped: true },
    ]);
    expect(sent.map((call) => call.sql)).toEqual([SQL_ENQUEUE_MANY, SQL_ENQUEUE_MANY_RESOLVE]);
  });

  test("onConflict 'error' is refused before any statement; a repeated publish is deduped", async () => {
    const refused = scripted([]);
    const outcome = await pgEnqueueMany(
      refused.exec,
      clock,
      [request('a', { onConflict: 'error' })],
      unused,
    ).catch((error: unknown) => error);
    expect((outcome as UltimateError).code).toBe('X_INVARIANT');
    expect(refused.sent).toEqual([]);

    const held = request('a');
    const repeat = scripted([[], [{ ord: 0, id: held.id, run_id: 'r' }]]);
    expect(await pgEnqueueMany(repeat.exec, clock, [held], unused)).toEqual([
      { id: held.id ?? '', runId: 'r', deduped: true },
    ]);
  });

  test('a row neither statement answers goes back through enqueue', async () => {
    const lost = request('a');
    const { exec } = scripted([[], []]);
    const again: EnqueueRequest[] = [];
    const results = await pgEnqueueMany(exec, clock, [lost], (one) => {
      again.push(one);
      return Promise.resolve({ id: 'late', runId: 'late-run', deduped: false });
    });
    expect(results).toEqual([{ id: 'late', runId: 'late-run', deduped: false }]);
    expect(again.map((one) => one.id)).toEqual([lost.id]);
  });

  test('both statements are shaped as the single enqueue: conflict target and the id fence', () => {
    expect(SQL_ENQUEUE_MANY).toContain(
      "on conflict (name, (coalesce(tenant_id, '')), idempotency_key)",
    );
    expect(SQL_ENQUEUE_MANY).toContain('where not exists (select 1 from x_jobs published');
    expect(SQL_ENQUEUE_MANY).toContain('order by q.ord');
    expect(SQL_ENQUEUE_MANY_RESOLVE).toContain(
      "coalesce(j.tenant_id, '') = coalesce(t.r->>'tenantId', '')",
    );
  });
});
