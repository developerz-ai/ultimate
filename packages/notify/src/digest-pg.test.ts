// The Postgres digest store over a recording executor: the window rules are Postgres's (see
// `digest-parity.live.test.ts`), but how the store READS each answer — and when it seals and asks
// again — is this package's, and runs without a server.

import { describe, expect, test } from 'bun:test';
import type { PgExecutor } from '@ultimat3/jobs';
import type { DigestSlot } from './digest';
import {
  createPgDigestStore,
  DEFAULT_DIGEST_RETENTION_MS,
  DIGEST_PURGE_BATCH,
  DIGEST_PURGE_MAX_BATCHES,
  SQL_NOTIFY_DIGEST_APPEND,
  SQL_NOTIFY_DIGEST_DRAIN,
  SQL_NOTIFY_DIGEST_SEAL,
  SQL_NOTIFY_DIGESTS_PURGE,
  SQL_NOTIFY_DIGESTS_TABLE,
} from './digest-pg';

const slot: DigestSlot = { recipient: 'ana', notifier: 'post.liked', channel: 'email', group: 'g' };
const NOW = new Date('2026-10-02T09:00:00Z');
const event = { notifier: 'post.liked', key: 'like:p1', params: {}, at: NOW };

interface Call {
  readonly sql: string;
  readonly params: readonly unknown[];
}

const recording = (answer: (call: Call) => readonly unknown[], calls: Call[]): PgExecutor => ({
  query: <R>(sql: string, params: readonly unknown[]): Promise<readonly R[]> => {
    const call = { sql, params };
    calls.push(call);
    return Promise.resolve(answer(call) as readonly R[]);
  },
});

const append = (executor: PgExecutor) =>
  createPgDigestStore({ executor }).append({ slot, event, windowMs: 60_000, now: NOW });

describe('unit · postgres digest store', () => {
  test('the row the upsert answers is the bucket: opened, and the close time as epoch ms', async () => {
    const calls: Call[] = [];
    const endsAt = new Date(NOW.getTime() + 60_000);
    const bucket = await append(
      recording(() => [{ ends_at: endsAt.toISOString(), opened: true }], calls),
    );
    expect(bucket).toEqual({ opened: true, endsAt: endsAt.getTime() });
    expect(calls.map((call) => call.sql)).toEqual([SQL_NOTIFY_DIGEST_APPEND]);
    expect(calls[0]?.params).toEqual([
      'ana',
      'post.liked',
      'email',
      'g',
      JSON.stringify([event]),
      endsAt,
      NOW,
    ]);
  });

  test('no row means the open window elapsed: it is sealed and the append asked again', async () => {
    const calls: Call[] = [];
    let appends = 0;
    const bucket = await append(
      recording((call) => {
        if (call.sql !== SQL_NOTIFY_DIGEST_APPEND) return [];
        appends += 1;
        return appends === 1 ? [] : [{ ends_at: NOW, opened: false }];
      }, calls),
    );
    expect(bucket).toEqual({ opened: false, endsAt: NOW.getTime() });
    expect(calls.map((call) => call.sql)).toEqual([
      SQL_NOTIFY_DIGEST_APPEND,
      SQL_NOTIFY_DIGEST_SEAL,
      SQL_NOTIFY_DIGEST_APPEND,
    ]);
    expect(calls[1]?.params).toEqual(['ana', 'post.liked', 'email', 'g', NOW]);
  });

  test('a window that never stays open is a coded refusal, never an endless loop', async () => {
    const calls: Call[] = [];
    await expect(append(recording(() => [], calls))).rejects.toBeUltimateError('X_INVARIANT');
    expect(calls.filter((call) => call.sql === SQL_NOTIFY_DIGEST_SEAL).length).toBe(9);
  });

  test('a drain hands back every window’s events, flattened, with `at` a Date again', async () => {
    const calls: Call[] = [];
    const stored = (key: string) => ({ ...event, key, at: NOW.toISOString() });
    const store = createPgDigestStore({
      executor: recording(
        () => [{ events: [stored('e1'), stored('e2')] }, { events: [stored('e3')] }],
        calls,
      ),
    });
    const drained = await store.drain(slot);
    expect(drained.map((one) => one.key)).toEqual(['e1', 'e2', 'e3']);
    expect(drained[0]?.at).toEqual(NOW);
    // No window named: `null`, which the statement reads as "the oldest window alone".
    expect(calls[0]).toEqual({
      sql: SQL_NOTIFY_DIGEST_DRAIN,
      params: ['ana', 'post.liked', 'email', 'g', null],
    });
    await store.drain(slot, NOW.getTime());
    expect(calls[1]?.params.at(-1)).toEqual(NOW);
  });

  test('at most one OPEN window per slot is the index, not a convention', () => {
    expect(SQL_NOTIFY_DIGESTS_TABLE).toContain(
      'on x_notify_digests (recipient, notifier, channel, group_key) where not sealed',
    );
    expect(SQL_NOTIFY_DIGEST_APPEND).toContain(
      'on conflict (recipient, notifier, channel, group_key) where not sealed',
    );
  });
});

describe('unit · postgres digest retention', () => {
  const PURGE_AT = NOW.getTime();

  test('the default keeps a closed window a week, and the cutoff is the caller clock minus it', async () => {
    const calls: Call[] = [];
    const store = createPgDigestStore({ executor: recording(() => [{ seq: 1 }], calls) });
    expect(store.retentionMs).toBe(DEFAULT_DIGEST_RETENTION_MS);
    expect(DEFAULT_DIGEST_RETENTION_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(await store.purgeExpired(PURGE_AT)).toBe(1);
    expect(calls).toEqual([
      {
        sql: SQL_NOTIFY_DIGESTS_PURGE,
        params: [new Date(PURGE_AT - DEFAULT_DIGEST_RETENTION_MS), DIGEST_PURGE_BATCH],
      },
    ]);
  });

  test('batched: a full batch asks again, a short one ends the pass', async () => {
    const calls: Call[] = [];
    const full = Array.from({ length: DIGEST_PURGE_BATCH }, (_, seq) => ({ seq }));
    let pass = 0;
    const store = createPgDigestStore({
      executor: recording(() => (pass++ < 2 ? full : [{ seq: 0 }]), calls),
      retentionMs: 1000,
    });
    expect(await store.purgeExpired(PURGE_AT)).toBe(DIGEST_PURGE_BATCH * 2 + 1);
    expect(calls).toHaveLength(3);
  });

  test('bounded: one pass deletes at most its batch ceiling, the next hourly pass goes on', async () => {
    const calls: Call[] = [];
    const full = Array.from({ length: DIGEST_PURGE_BATCH }, (_, seq) => ({ seq }));
    const store = createPgDigestStore({ executor: recording(() => full, calls) });
    expect(await store.purgeExpired(PURGE_AT)).toBe(DIGEST_PURGE_BATCH * DIGEST_PURGE_MAX_BATCHES);
    expect(calls).toHaveLength(DIGEST_PURGE_MAX_BATCHES);
  });

  test('a retention that is not a whole positive count is refused at construction', () => {
    expect(() =>
      createPgDigestStore({ executor: recording(() => [], []), retentionMs: 0 }),
    ).toThrow('X_INVARIANT');
  });
});
