// The worker fixture's CPU burn, in-process: it spends the asked CPU time of THIS process, which is
// what lets `runtime-jobs-processes.live.test.ts` read overlap as two processes burning at once.

import { describe, expect, test } from 'bun:test';
import { burnCpu } from './runtime-jobs-processes-fixture';

describe('unit · the worker processes fixture', () => {
  test('burnCpu spends at least the asked CPU time of this process', () => {
    // why: Bun has no CPU-time reading of its own; `process.cpuUsage()` is the per-process counter.
    const before = process.cpuUsage();
    burnCpu(40);
    const spent = process.cpuUsage(before);
    expect((spent.user + spent.system) / 1000).toBeGreaterThanOrEqual(40);
  });
});
