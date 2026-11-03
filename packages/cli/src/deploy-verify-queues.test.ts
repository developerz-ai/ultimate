// The queue grade's real sources with no database: the expected set off a real app root, the reader
// over the memory driver, and the pg reader's failure when nothing listens. The statements
// themselves are `cmd-deploy-verify.live.test.ts`'s.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; Bun.write takes one already joined.
import { join } from 'node:path';
import { ctxOf, isUltimateError } from '@ultimat3/core';
import { jobWorker, memoryJobDriver, resetJobs } from '@ultimat3/jobs';
import { resetAppLoad } from './app-load';
import { gradeQueues } from './deploy-verify-grade';
import { expectedQueues, openQueue, queueReaderOf } from './deploy-verify-queues';
import { processRoot } from './process-root-fixture';

const ROOT = processRoot(join(import.meta.dir, '..', '.deploy-verify-queues-fixture'));

const FILES: Readonly<Record<string, string>> = {
  'package.json': JSON.stringify({ name: 'deploy-verify-queues-fixture', version: '1.0.0' }),
  'app.config.ts': `import { defineConfig } from '@ultimat3/core';
export const config = defineConfig({ name: 'deploy-verify-queues-fixture', jobs: { queues: ['banks'] } });
`,
  'apps/web/app/digest/jobs.ts': `import { job, t } from '@ultimat3/jobs';
export const digest = job({
  name: 'deploy-verify-digest',
  queue: 'digests',
  input: t.object({ day: t.string }),
  idempotencyKey: (input) => input.day,
  tenant: 'none',
  retry: { attempts: 1, backoff: 'fixed' },
  run: () => undefined,
});
`,
};

afterEach(() => {
  resetJobs();
});

afterAll(async () => {
  resetAppLoad();
  await rm(ROOT, { recursive: true, force: true });
});

const closed = () => Promise.resolve();

describe('the queues x deploy verify expects', () => {
  test('jobs.queues plus every registered job queue, with no finding', async () => {
    // One process runs the whole package: another file's jobs are not this app's.
    resetJobs();
    for (const [path, text] of Object.entries(FILES)) await Bun.write(join(ROOT, path), text);
    const expected = await expectedQueues(ROOT);
    expect(expected.findings).toEqual([]);
    expect([...expected.queues].sort()).toEqual(['banks', 'digests']);
  });
});

describe('the reader over a driver', () => {
  test('a serving worker of this build serves its queue; the other queue with work does not', async () => {
    const driver = memoryJobDriver();
    await driver.enqueue({
      name: 'any',
      queue: 'digests',
      input: {},
      idempotencyKey: 'waiting',
      maxAttempts: 1,
    });
    const worker = jobWorker({
      driver,
      workerId: 'w-new',
      queues: ['banks'],
      build: 'b-new',
      context: () => ctxOf({ role: 'worker', buildId: 'b-new' }),
      drainOnShutdown: false,
    });
    worker.start();
    const reader = queueReaderOf(driver, closed);
    const [workers, demand] = await Promise.all([reader.workers(), reader.demand()]);
    await worker.stop();
    expect(demand).toEqual([{ queue: 'digests', demand: 1 }]);
    const grade = gradeQueues({
      build: 'b-new',
      expected: ['banks', 'digests'],
      workers,
      depth: new Map(demand.map((queue) => [queue.queue, queue.demand])),
      idleOk: [],
    });
    expect(grade.served).toEqual(['banks']);
    expect(grade.unserved).toEqual([{ queue: 'digests', builds: [], depth: 1 }]);
  });

  test('a driver with no registry lists no worker, so nothing reads served', async () => {
    const { introspect: _introspect, ...bare } = memoryJobDriver();
    const reader = queueReaderOf(bare, closed);
    expect(await reader.workers()).toEqual([]);
    expect(await reader.demand()).toEqual([]);
  });
});

describe('the pg reader', () => {
  test('a read with nothing listening rejects, and the pool still closes', async () => {
    // Port 1 on loopback: refused at once on every machine, and never egress.
    const reader = await openQueue('postgres://x:x@127.0.0.1:1/none', {});
    const failure = await reader.workers().then(
      () => expect.unreachable('a read with no database answered'),
      (error: unknown) => error,
    );
    expect(failure).toBeDefined();
    expect(isUltimateError(failure) || failure instanceof Error).toBe(true);
    await reader.close();
  });
});
