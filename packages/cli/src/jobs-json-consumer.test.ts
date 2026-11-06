// `x jobs show <id> --json`'s `consumer` row: the key, when the run last committed a batch, and its
// lag when the declaration has a `lag()` — `null` for every job that is not a `consumer()` run.

import { afterEach, describe, expect, test } from 'bun:test';
import { consumer, inspectJob, memoryJobDriver, resetJobs } from '@ultimat3/jobs';
import { jobTraceToJson } from './jobs-json';

afterEach(() => {
  resetJobs();
});

const declare = (name: string, lags: boolean) =>
  consumer<number, number>({
    name,
    tenant: 'none',
    keys: () => ['acct-1'],
    async *open() {},
    handle: () => 0,
    cursor: { load: () => null, save: () => undefined },
    ...(lags ? { lag: () => 0 } : {}),
  });

async function traceOf(name: string, key: string, progress?: [number, number]) {
  const driver = memoryJobDriver();
  const { id } = await driver.enqueue({
    name,
    queue: 'default',
    input: { key },
    idempotencyKey: `consumer:${name}:${key}`,
    maxAttempts: 3,
  });
  if (progress !== undefined) {
    const [claimed] = await driver.claim({
      queues: ['default'],
      workerId: 'w',
      limit: 1,
      visibilityTimeoutMs: 30_000,
    });
    if (claimed === undefined) return expect.unreachable('nothing to claim');
    await driver.introspect?.recordProgress(
      claimed.id,
      { workerId: 'w', claim: claimed.claim },
      { done: progress[0], total: progress[1], note: 'consumer', at: Date.UTC(2026, 10, 6) },
    );
  }
  const trace = await inspectJob(driver, id);
  if (trace === undefined) return expect.unreachable(`no trace for ${id}`);
  return jobTraceToJson(trace);
}

describe('unit · the consumer row', () => {
  test('a consumer run reports its key, its last batch and its declared lag', async () => {
    declare('orders-lagging', true);
    expect(await traceOf('orders-lagging', 'acct-1', [10, 14])).toMatchObject({
      consumer: { key: 'acct-1', lastBatchAt: '2026-11-06T00:00:00.000Z', lag: 4 },
    });
  });

  test('no lag declared is null, and no batch yet is null', async () => {
    declare('orders-silent', false);
    expect(await traceOf('orders-silent', 'acct-1', [10, 10])).toMatchObject({
      consumer: { key: 'acct-1', lag: null },
    });
    expect(await traceOf('orders-silent', 'acct-2')).toMatchObject({
      consumer: { key: 'acct-2', lastBatchAt: null, lag: null },
    });
  });

  test('a job that is not a consumer carries an explicit null', async () => {
    const json = await traceOf('send-email', 'k');
    expect(Object.keys(json as Record<string, unknown>)).toContain('consumer');
    expect(json).toMatchObject({ consumer: null });
  });
});
