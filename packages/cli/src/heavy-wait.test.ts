// What a waiter is told and how long it stays: the line that says what to do, and `maxWaitMs`, the
// one bound on a queue that otherwise waits for as long as the holders run.

import { afterEach, describe, expect, test } from 'bun:test';
// why: a temp ledger per test; Bun ships no mkdtemp.
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
// why: the test's scratch root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { waitLine } from './heavy';
import { flockBinding } from './heavy-flock';
import type { LedgerWait } from './heavy-ledger';
import { reserve } from './heavy-ledger';

// flock(2) does not exist on Windows, where admission is off (`heavy-flock.ts`).
const NO_FLOCK = process.platform === 'win32';
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'heavy-wait-'));
  dirs.push(dir);
  return dir;
};

const tryLock = async () => {
  const binding = await flockBinding();
  if (!binding.ok) expect.unreachable(binding.reason);
  return binding.tryLock;
};

const WAIT: LedgerWait = {
  needMb: 100,
  usedMb: 90,
  capacityMb: 100,
  position: 1,
  queued: 2,
  holds: [{ pid: 7, mb: 90, label: 'gate', cwd: '/w/app', at: 1000 }],
};

describe('the wait line', () => {
  test('names the holder and says the wait needs nothing from the reader', () => {
    const line = waitLine('x test unit', WAIT, 4000);
    expect(line).toContain('position 1 of 2');
    expect(line).toContain('gate (/w/app, 90 MB, 3s)');
    expect(line).toContain('leave it running; it starts by itself');
    expect(line).toContain('bunx x heavy status');
  });

  test('with nobody holding yet it says an admission is under way, never "held by -"', () => {
    const line = waitLine('x test unit', { ...WAIT, usedMb: 0, holds: [] }, 4000);
    expect(line).toContain('admission in progress');
    expect(line).not.toContain('held by');
    expect(line).toContain('leave it running');
  });
});

describe('the wait line when the CPU is the reason', () => {
  test('says so, with the figure, and still says to leave it running', () => {
    const cpu = { source: 'psi', value: 95.8, limit: 80, busy: true } as const;
    const line = waitLine('x test unit', { ...WAIT, cpu }, 4000);
    expect(line).toContain('waits for CPU');
    expect(line).toContain('CPU pressure 96% (new runs wait at 80%)');
    expect(line).toContain('gate (/w/app');
    expect(line).toContain('leave it running');
  });
});

describe.skipIf(NO_FLOCK)('reserve with maxWaitMs', () => {
  const input = async (dir: string, label: string, maxWaitMs?: number) => ({
    dir,
    capacityMb: 10,
    unitMb: 10,
    units: 1,
    label,
    cwd: '/w',
    tryLock: await tryLock(),
    pollMs: 5,
    ...(maxWaitMs === undefined ? {} : { maxWaitMs }),
  });

  test('gives up with the coded error naming the holder, and leaves the queue', async () => {
    const dir = scratch();
    const holder = await reserve(await input(dir, 'holder'));
    const refused = await reserve(await input(dir, 'late', 20)).catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: 'X_HEAVY_WAIT_EXPIRED' });
    expect((refused as { cause: string }).cause).toContain('holder');
    expect(readdirSync(join(dir, 'queue'))).toEqual([]);
    expect(readdirSync(join(dir, 'holds'))).toHaveLength(1);
    holder.release();
  });

  test('0 still admits a request that fits now', async () => {
    const held = await reserve(await input(scratch(), 'alone', 0));
    expect(held.units).toBe(1);
    held.release();
  });

  test('a holder that leaves in time admits the waiter', async () => {
    const dir = scratch();
    const holder = await reserve(await input(dir, 'holder'));
    const waiter = reserve({ ...(await input(dir, 'next', 30_000)), onWait: holder.release });
    const held = await waiter;
    expect(held.units).toBe(1);
    held.release();
  });
});
