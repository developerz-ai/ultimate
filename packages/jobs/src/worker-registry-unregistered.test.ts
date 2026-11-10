// `jobs.worker.queue-unregistered`: the boot line naming a polled queue no registered job targets.
// It is worth reading only when it is a config leftover, so `default` — where every `job()` naming
// no queue lands, and `jobWorker`'s own fallback — is never in it: a fresh app logged it on every
// boot of every pod, and a line that is always there is a line nobody reads.

import { afterEach, describe, expect, test } from 'bun:test';
import { installLogSink } from '@ultimat3/core';
import { t } from '@ultimat3/schema';
import { job, resetJobs } from './job';
import { reportUnregisteredQueues } from './worker-registry';

afterEach(() => resetJobs());

const reported = (queues: readonly string[]): readonly unknown[] => {
  const lines: { msg?: string; queues?: unknown }[] = [];
  const releaseLogSink = installLogSink((line) => {
    lines.push(JSON.parse(line) as { msg?: string; queues?: unknown });
  });
  try {
    reportUnregisteredQueues('w-1', queues);
  } finally {
    releaseLogSink();
  }
  return lines.filter((line) => line.msg === 'jobs.worker.queue-unregistered').map((l) => l.queues);
};

describe('reportUnregisteredQueues', () => {
  test('an app with no jobs yet polling `default` says nothing', () => {
    expect(reported(['default'])).toEqual([]);
  });

  test('a leftover queue no job names is still reported, and only it', () => {
    job({
      name: 'unregistered-probe',
      tenant: 'none',
      input: t.object({}),
      queue: 'mail',
      idempotencyKey: () => 'probe',
      retry: { attempts: 1 },
      run: () => Promise.resolve(),
    });
    expect(reported(['default', 'mail', 'demo-default'])).toEqual([['demo-default']]);
  });
});
