// One slot default in the framework: a queue `concurrency` names no number for runs at core's
// `JOBS_CONCURRENCY_DEFAULT` — what `app.config.ts`'s `jobs.concurrency` defaults to — never a
// second, smaller number of this package's own (it was 5 beside the config's 8 until 25.0.0).

import { describe, expect, test } from 'bun:test';
import { JOBS_CONCURRENCY_DEFAULT } from '@ultimat3/core';
import { resolveWorkerTimings, WORKER_REGISTRY_TTL_MS } from './worker-options';

describe('unit · resolveWorkerTimings · slotsFor', () => {
  test('no concurrency at all is the config default on every queue', () => {
    expect(resolveWorkerTimings({}).slotsFor('mail')).toBe(JOBS_CONCURRENCY_DEFAULT);
  });

  test('a table names its own queues; one it leaves out runs at the config default', () => {
    const { slotsFor } = resolveWorkerTimings({ concurrency: { banks: 4, 'banks-long': 2 } });
    expect(slotsFor('banks')).toBe(4);
    expect(slotsFor('banks-long')).toBe(2);
    expect(slotsFor('default')).toBe(JOBS_CONCURRENCY_DEFAULT);
  });

  test('a queue named like an Object member is read by own key only', () => {
    expect(resolveWorkerTimings({ concurrency: { banks: 4 } }).slotsFor('constructor')).toBe(
      JOBS_CONCURRENCY_DEFAULT,
    );
  });

  test('a number applies to every queue', () => {
    expect(resolveWorkerTimings({ concurrency: 3 }).slotsFor('anything')).toBe(3);
  });
});

describe('unit · resolveWorkerTimings · the registry row', () => {
  test('a 60s row renewed every 20s, decoupled from the 10s lease heartbeat', () => {
    const timings = resolveWorkerTimings({});
    expect(timings.heartbeatIntervalMs).toBe(10_000);
    expect(timings.registryTtlMs).toBe(WORKER_REGISTRY_TTL_MS);
    expect(WORKER_REGISTRY_TTL_MS).toBe(60_000);
    expect(timings.registryIntervalMs).toBe(20_000);
  });

  test('a visibility longer than the TTL stretches the row: it never lapses before its jobs do', () => {
    const timings = resolveWorkerTimings({ visibilityTimeoutMs: 300_000 });
    expect(timings.registryTtlMs).toBe(300_000);
    expect(timings.registryIntervalMs).toBe(100_000);
  });
});
