// An exact worker (`WORKER_QUEUES`) warns about a registered queue only when NO live worker in the
// registry serves it. A split fleet — `banks` here, `default` on another Deployment — is a correct
// deployment, and warned at every boot it taught operators to ignore the one line that mattered.

import { describe, expect, test } from 'bun:test';
import { installLogSink } from '@ultimat3/core';
import type { WorkerRecord } from '@ultimat3/jobs';
import { reportUnservedQueues } from './runtime-jobs-unserved';

async function logged(run: () => Promise<void>): Promise<readonly Record<string, unknown>[]> {
  const lines: string[] = [];
  const releaseLogSink = installLogSink((line) => {
    lines.push(line);
  });
  try {
    await run();
  } finally {
    releaseLogSink();
  }
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

const row = (workerId: string, queues: readonly string[], draining = false): WorkerRecord => ({
  id: workerId,
  host: 'pod',
  queues,
  concurrency: 1,
  inFlight: [],
  startedAt: 0,
  heartbeatAt: 0,
  ...(draining ? { draining: true, drainingAt: 0 } : {}),
});

const unservedLine = (lines: readonly Record<string, unknown>[]) =>
  lines.find((line) => line['msg'] === 'jobs.worker.queue-unserved');

describe('unit · reportUnservedQueues', () => {
  const registered = ['banks', 'banks-long', 'default'];

  test('a queue another live worker serves is no warning: the split is the deployment', async () => {
    const lines = await logged(() =>
      reportUnservedQueues({
        served: ['banks'],
        registered,
        workers: async () => [row('me', ['banks']), row('other', ['banks-long', 'default'])],
      }),
    );
    expect(unservedLine(lines)).toBeUndefined();
  });

  test('a queue no live worker serves is warned, by name, with what to do', async () => {
    const lines = await logged(() =>
      reportUnservedQueues({
        served: ['banks'],
        registered,
        // A draining worker is leaving: it serves nothing new.
        workers: async () => [row('me', ['banks']), row('old', ['default'], true)],
      }),
    );
    const line = unservedLine(lines);
    expect(line?.['level']).toBe('warn');
    expect(line?.['queues']).toEqual(['banks-long', 'default']);
    expect(String(line?.['fix'])).toContain('WORKER_QUEUES');
  });

  test('with no registry to ask, it says so at info: it cannot tell a split from a gap', async () => {
    const lines = await logged(() =>
      reportUnservedQueues({ served: ['banks'], registered, workers: undefined }),
    );
    expect(unservedLine(lines)?.['level']).toBe('info');
  });

  test('a registry read that fails is info too, never a rejection', async () => {
    const lines = await logged(() =>
      reportUnservedQueues({
        served: ['banks'],
        registered,
        workers: () => Promise.reject(new TypeError('pool closed')),
      }),
    );
    expect(unservedLine(lines)?.['level']).toBe('info');
  });

  test('a worker that serves every registered queue asks nothing', async () => {
    let asked = false;
    const lines = await logged(() =>
      reportUnservedQueues({
        served: registered,
        registered,
        workers: async () => {
          asked = true;
          return [];
        },
      }),
    );
    expect(asked).toBe(false);
    expect(unservedLine(lines)).toBeUndefined();
  });
});
