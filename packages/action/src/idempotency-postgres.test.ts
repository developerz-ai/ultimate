// The shared store's PROTOCOL, driven through a recording executor rather than a live database:
// one atomic `insert … on conflict` decides who runs the handler, an empty result means someone
// else owns the reservation, and a row outside the window is reclaimed rather than replayed.

import { describe, expect, test } from 'bun:test';
import type { PgExecutor } from './idempotency-postgres';
import { postgresIdempotencyStore, SQL_IDEMPOTENCY_TABLE } from './idempotency-postgres';

interface Call {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** Answers each statement from a scripted queue and records what it was asked. */
function executor(answers: readonly (readonly Record<string, unknown>[])[]): {
  readonly exec: PgExecutor;
  readonly calls: readonly Call[];
} {
  const calls: Call[] = [];
  let index = 0;
  const exec: PgExecutor = {
    query<R>(sql: string, params: readonly unknown[]): Promise<readonly R[]> {
      calls.push({ sql, params });
      const answer = answers[index] ?? [];
      index += 1;
      return Promise.resolve(answer as readonly R[]);
    },
  };
  return { exec, calls };
}

const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  key: 'chargeCard:k1',
  id: '00000000-0000-4000-8000-0000000000aa',
  request_hash: 'hash',
  status: 'in-flight',
  value: null,
  failure: null,
  created_at: '1700000000000',
  ...over,
});

describe('the postgres idempotency store', () => {
  test('declares itself shared, which is the whole reason it exists', () => {
    const { exec } = executor([]);
    expect(postgresIdempotencyStore({ executor: exec }).scope).toBe('shared');
  });

  test('a returned row is the caller that must run the handler', async () => {
    const { exec, calls } = executor([[row()]]);
    const store = postgresIdempotencyStore({ executor: exec });
    const reservation = await store.reserve('chargeCard:k1', 'hash');
    expect(reservation.created).toBe(true);
    expect(reservation.record.status).toBe('in-flight');
    // One statement, not a select-then-insert: the atomicity is the point.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain('on conflict (key) do update');
  });

  test('no row back means a live record exists and this caller must replay it', async () => {
    const { exec, calls } = executor([[], [row({ status: 'settled', value: { ok: true } })]]);
    const store = postgresIdempotencyStore({ executor: exec });
    const reservation = await store.reserve('chargeCard:k1', 'hash');
    expect(reservation.created).toBe(false);
    expect(reservation.record.status).toBe('settled');
    expect(reservation.record.value).toEqual({ ok: true });
    expect(calls[1]?.sql).toContain('created_at >= now()');
  });

  test('a failed record comes back with its failure, so the replay re-throws it', async () => {
    const failure = { code: 'X_OUTPUT_INVALID', cause: 'shape drifted', fix: 'fix the schema' };
    const { exec } = executor([[], [row({ status: 'failed', failure })]]);
    const store = postgresIdempotencyStore({ executor: exec });
    const reservation = await store.reserve('chargeCard:k1', 'hash');
    expect(reservation.record.failure).toEqual(failure);
  });

  test('a jsonb failure that is not the declared shape is dropped, never half-read', async () => {
    const { exec } = executor([[], [row({ status: 'failed', failure: { code: 42 } })]]);
    const store = postgresIdempotencyStore({ executor: exec });
    expect((await store.reserve('chargeCard:k1', 'hash')).record.failure).toBeUndefined();
  });

  test('the window travels as seconds, so the same number bounds reserve, get and purge', async () => {
    const { exec, calls } = executor([[], []]);
    const store = postgresIdempotencyStore({ executor: exec, windowMs: 60_000 });
    await store.reserve('k', 'hash');
    expect(calls[0]?.params[3]).toBe(60);
    expect(calls[1]?.params[1]).toBe(60);
  });

  test('the install statement creates the table and its sweep index', () => {
    expect(SQL_IDEMPOTENCY_TABLE).toContain('create table if not exists x_idempotency');
    expect(SQL_IDEMPOTENCY_TABLE).toContain('x_idempotency_created_at_idx');
  });
});
