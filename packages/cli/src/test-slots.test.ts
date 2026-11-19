// A test run's lease, against a real ledger: the width it is given and what its children inherit.

import { afterEach, describe, expect, test } from 'bun:test';
// why: a temp ledger per test; Bun ships no mkdtemp.
import { mkdtempSync, rmSync } from 'node:fs';
// why: the test's scratch root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { HEAVY_HOLD_ENV } from './heavy-env';
import { E2E_LANE_PEAK_MB, TEST_RUN_BASE_MB, TEST_WORKER_PEAK_MB } from './heavy-weights';
import { machineLease, suiteWeight } from './test-slots';

// flock(2) does not exist on Windows, where admission is off (`heavy-flock.ts`).
const NO_FLOCK = process.platform === 'win32';
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ledger = (workers: number) => {
  const dir = mkdtempSync(join(tmpdir(), 'test-slots-'));
  dirs.push(dir);
  return {
    NODE_ENV: 'development',
    ULTIMATE_HEAVY_DIR: dir,
    ULTIMATE_HEAVY_MEMORY: `${String(2 * TEST_RUN_BASE_MB + workers * TEST_WORKER_PEAK_MB)}m`,
    ULTIMATE_HEAVY_CORES: '16',
  };
};

const lease = (env: Record<string, string>, exact = false) => {
  const take = machineLease(env, { cwd: '/app', label: 'test', ...(exact ? { exact } : {}) });
  if (take === undefined) expect.unreachable('the lease is on');
  return take;
};

describe.skipIf(NO_FLOCK)('machineLease', () => {
  test('a run narrows to the workers the ledger has room for, and hands its children the hold', async () => {
    const take = lease(ledger(3));
    const first = await take(2);
    expect(first.count).toBe(2);
    expect(first.env?.[HEAVY_HOLD_ENV]).toContain('/holds/');
    expect(first.fds).toHaveLength(1);
    const second = await take(4);
    expect(second.count).toBe(1);
    first.release();
    second.release();
  });

  test('the core cap narrows a default run', async () => {
    const take = lease({ ...ledger(8), ULTIMATE_HEAVY_CORES: '2' });
    const held = await take(6);
    expect(held.count).toBe(2);
    held.release();
  });

  test('an explicit width is neither capped nor narrowed', async () => {
    const take = lease({ ...ledger(8), ULTIMATE_HEAVY_CORES: '2' }, true);
    const held = await take(6);
    expect(held.count).toBe(6);
    held.release();
  });

  test('a released lease is room for the next run', async () => {
    const take = lease(ledger(1));
    (await take(1)).release();
    const again = await take(1);
    expect(again.count).toBe(1);
    again.release();
  });

  test('inside a test run nothing is reserved and the ask stands', async () => {
    const take = machineLease({ NODE_ENV: 'test' }, { cwd: '/app', label: 'test' });
    const held = await take?.(5);
    expect(held?.count).toBe(5);
    expect(held?.env).toEqual({});
  });

  test('ULTIMATE_TEST_SLOTS=0 still turns the lease off', () => {
    expect(
      machineLease({ ULTIMATE_TEST_SLOTS: '0' }, { cwd: '/app', label: 'test' }),
    ).toBeUndefined();
  });

  test('an e2e lane reserves a browser, not a test worker', () => {
    expect(suiteWeight('e2e')).toEqual({ unitMb: E2E_LANE_PEAK_MB, baseMb: 0 });
    expect(suiteWeight('unit')).toEqual({
      unitMb: TEST_WORKER_PEAK_MB,
      baseMb: TEST_RUN_BASE_MB,
    });
  });
});
