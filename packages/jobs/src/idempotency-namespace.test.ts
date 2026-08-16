// J1: the idempotency key namespace is per JOB, not global. The failure this pins is silent —
// no error, no dead letter, one healthy-looking row — so it is the first test in the file.

import { describe, expect, test } from 'bun:test';
import { createMemoryDriver } from './driver-memory';
import type { PgExecutor } from './driver-pg';
import { createPgDriver } from './driver-pg';
import { SQL_ENQUEUE, SQL_FIND_LIVE_BY_KEY } from './driver-pg-sql';

const enqueue = (name: string, key: string) => ({
  name,
  queue: 'default',
  input: { userId: 42 },
  idempotencyKey: key,
  maxAttempts: 3,
});

describe('the idempotency namespace', () => {
  test('two DIFFERENT jobs sharing a natural key both run', async () => {
    // The scenario: team A ships sendWelcomeEmail with `user:${id}`, team B ships
    // provisionWorkspace six months later with the same natural key, one signup enqueues both.
    // Before this, the second enqueue deduped into the first job's row and returned ITS id — the
    // workspace was never provisioned, nothing was raised, and `x jobs ls` showed one healthy job.
    const driver = createMemoryDriver();

    const welcome = await driver.enqueue(enqueue('sendWelcomeEmail', 'user:42'));
    const workspace = await driver.enqueue(enqueue('provisionWorkspace', 'user:42'));

    expect(welcome.deduped).toBe(false);
    expect(workspace.deduped).toBe(false);
    expect(workspace.id).not.toBe(welcome.id);

    const queued = await driver.introspect?.list();
    expect(queued?.map((row) => row.name).sort()).toEqual([
      'provisionWorkspace',
      'sendWelcomeEmail',
    ]);
  });

  test('the SAME job with the same key still dedupes — the guarantee is unchanged', async () => {
    const driver = createMemoryDriver();
    const first = await driver.enqueue(enqueue('sendWelcomeEmail', 'user:42'));
    const second = await driver.enqueue(enqueue('sendWelcomeEmail', 'user:42'));

    expect(second.deduped).toBe(true);
    expect(second.id).toBe(first.id);
  });

  test('a completed job frees its key for the same job again', async () => {
    const driver = createMemoryDriver();
    const first = await driver.enqueue(enqueue('sendWelcomeEmail', 'user:42'));
    await driver.claim({ queues: ['default'], limit: 1, visibilityTimeoutMs: 1000, workerId: 'w' });
    await driver.ack(first.id);

    const second = await driver.enqueue(enqueue('sendWelcomeEmail', 'user:42'));
    expect(second.deduped).toBe(false);
  });

  test('the pg driver looks the live row up by NAME as well as key', async () => {
    // The dedupe lookup has to match the index. One that did not would answer with whichever
    // stranger held the key, and `{ deduped: true, id: <someone else's> }` is the data loss.
    const calls: { sql: string; params: readonly unknown[] }[] = [];
    const executor: PgExecutor = {
      query<R>(sql: string, params: readonly unknown[]): Promise<readonly R[]> {
        calls.push({ sql, params });
        // `do nothing` fired: no inserted row comes back, then the live-row lookup answers.
        if (sql === SQL_ENQUEUE) return Promise.resolve([] as readonly R[]);
        return Promise.resolve([{ id: 'existing', run_id: 'run' }] as unknown as readonly R[]);
      },
    };
    const driver = createPgDriver({ executor });

    const result = await driver.enqueue(enqueue('provisionWorkspace', 'user:42'));

    expect(result.deduped).toBe(true);
    const lookup = calls.find((call) => call.sql === SQL_FIND_LIVE_BY_KEY);
    expect(lookup?.params).toEqual(['provisionWorkspace', 'user:42']);
  });
});
