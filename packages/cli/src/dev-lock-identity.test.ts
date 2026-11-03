// A pid is not an identity: a kill -9 leaves the lock, the pid is reused, and `x stop` must not
// signal the stranger. The start time read here is what the lock records beside the pid.

import { describe, expect, test } from 'bun:test';
import { processStartTime, startFromProcStat } from './dev-lock-identity';

describe('unit · processStartTime', () => {
  test('field 22 of /proc/<pid>/stat, past a comm that holds spaces and parentheses', () => {
    const stat =
      '4242 (my (odd) name) S 1 4242 4242 0 -1 4194304 1 0 0 0 0 0 0 0 20 0 1 0 17937476 6414';
    expect(startFromProcStat(stat)).toBe('17937476');
    expect(startFromProcStat('garbage')).toBeUndefined();
  });

  test('this process has one, it is stable, and a child started later has another', async () => {
    const mine = await processStartTime(process.pid);
    expect(mine).toBeDefined();
    expect(await processStartTime(process.pid)).toBe(mine);
    const later = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    try {
      expect(await processStartTime(later.pid)).not.toBe(mine);
    } finally {
      later.kill('SIGKILL');
    }
  });

  test('a pid no process holds has none', async () => {
    expect(await processStartTime(2 ** 22 + 7)).toBeUndefined();
  });
});
