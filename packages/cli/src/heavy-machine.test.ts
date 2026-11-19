// The inputs admission is computed from: the cgroup bound, the capacity, the core cap.

import { describe, expect, test } from 'bun:test';
import { defaultLedgerDir, describeEntry } from './heavy';
import {
  BUSY_CORE_FLOOR,
  coreCap,
  LOCAL_CORE_CAP,
  nativeToolEnv,
  parseRunnable,
} from './heavy-cores';
import { isCi } from './heavy-env';
import { flockBinding } from './heavy-flock';
import {
  availableMemoryBytes,
  cgroupLimitBytes,
  ledgerCapacityMb,
  usableMemoryBytes,
} from './heavy-memory';
import { raceDeadline } from './verify-deadline';

const files = (table: Record<string, string>) => (path: string) => table[path];
const GIB = 2 ** 30;

describe('memory', () => {
  test('the smallest memory.max along the chain binds, the root included', () => {
    const read = files({
      '/proc/self/cgroup': '0::/a/b\n',
      '/sys/fs/cgroup/memory.max': String(8 * GIB),
      '/sys/fs/cgroup/a/memory.max': String(2 * GIB),
      '/sys/fs/cgroup/a/b/memory.max': 'max\n',
    });
    expect(cgroupLimitBytes(read)).toBe(2 * GIB);
    expect(usableMemoryBytes(16 * GIB, cgroupLimitBytes(read))).toBe(2 * GIB);
  });
  test('no cgroup v2 means the host figure', () => {
    expect(cgroupLimitBytes(files({}))).toBeUndefined();
    expect(usableMemoryBytes(16 * GIB, undefined)).toBe(16 * GIB);
  });
  test('the capacity is half, an override replaces it, and 0 is off', () => {
    expect(ledgerCapacityMb({}, 32 * GIB)).toBe(16_384);
    expect(ledgerCapacityMb({ ULTIMATE_HEAVY_MEMORY: '8g' }, 32 * GIB)).toBe(8192);
    expect(ledgerCapacityMb({ ULTIMATE_HEAVY_MEMORY: '0' }, 32 * GIB)).toBe(0);
  });
  test('a bad override is coded', () => {
    expect(() => ledgerCapacityMb({ ULTIMATE_HEAVY_MEMORY: 'lots' })).toThrow(
      expect.objectContaining({ code: 'X_HEAVY_MEMORY_INVALID' }),
    );
  });
  test('MemAvailable is what a new process can get', () => {
    expect(availableMemoryBytes(files({ '/proc/meminfo': 'MemAvailable:  1024 kB\n' }))).toBe(
      2 ** 20,
    );
  });
});

describe('cores', () => {
  test('a quiet box gets the local cap, never more cores than exist', () => {
    expect(coreCap({}, 16, 0)).toBe(LOCAL_CORE_CAP);
    expect(coreCap({}, 1, 0)).toBe(1);
  });
  test('other runnable tasks shrink it to the floor', () => {
    expect(coreCap({}, 8, 5)).toBe(3);
    expect(coreCap({}, 8, 85)).toBe(BUSY_CORE_FLOOR);
  });
  test('CI has no ceiling and an override wins', () => {
    expect(coreCap({ CI: 'true' }, 8, 85)).toBeUndefined();
    expect(coreCap({ ULTIMATE_HEAVY_CORES: '6' }, 8, 85)).toBe(6);
  });
  test('CI is off for its false spellings', () => {
    expect(isCi({ CI: 'false' })).toBe(false);
    expect(isCi({ CI: '0' })).toBe(false);
    expect(isCi({ CI: '1' })).toBe(true);
  });
  test('the runnable count is the fourth field of loadavg', () => {
    expect(parseRunnable('0.5 0.6 0.7 12/1445 999\n')).toBe(12);
    expect(parseRunnable('garbled')).toBeUndefined();
  });
  test('an exported thread count is never overridden', () => {
    expect(nativeToolEnv({ GOMAXPROCS: '9' }, 4)).toEqual({ RAYON_NUM_THREADS: '4' });
    expect(nativeToolEnv({}, undefined)).toEqual({});
  });
});

describe('the rest of admission', () => {
  test('a platform with no flock says so instead of faking a lock', async () => {
    expect(await flockBinding('win32')).toEqual({
      ok: false,
      reason: 'flock(2) does not exist on win32',
    });
  });
  test('a holder is named by the end of its directory, with its size and age', () => {
    const cwd = `/${'deep/'.repeat(30)}my-checkout`;
    const entry = { pid: 1, mb: 512, label: 'x test', cwd, at: 1_000 };
    const line = describeEntry(entry, 61_000);
    expect(line).toContain('my-checkout, 512 MB, 1m00s');
    expect(line.length).toBeLessThan(90);
  });

  test('the ledger path never reads TMPDIR', () => {
    expect(defaultLedgerDir(1000)).toBe('/tmp/ultimate-heavy-1000');
  });
  test('time queued for the machine does not count against a step deadline', async () => {
    let finish: (value: string) => void = () => undefined;
    const work = new Promise<string>((resolve) => {
      finish = resolve;
    });
    let reads = 0;
    // The deadline fires, reads an hour of queueing, re-arms, and the work then finishes.
    const waited = (): number => {
      reads += 1;
      if (reads === 2) finish('done');
      return reads === 1 ? 0 : 3_600_000;
    };
    expect(await raceDeadline(work, 1, waited)).toEqual({ timedOut: false, value: 'done' });
  });
  test('a step that runs out of its own time still times out', async () => {
    const raced = await raceDeadline(new Promise(() => undefined), 10, () => 0);
    expect(raced).toEqual({ timedOut: true });
  });
});
