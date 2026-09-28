// The machine-wide slot pool: a second run on the same box gets what the first left, never double.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API; mkdtemp/rm own the fixture directory.
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { acquireSlots, slotsDir, slotsEnabled } from './test-slots';

const dirs: string[] = [];
const fresh = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'x-slots-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const noSleep = async (): Promise<void> => undefined;

describe('unit · machine test slots', () => {
  test('a second run while the first holds every slot does NOT get its own full width', async () => {
    const dir = fresh();
    const first = await acquireSlots({ dir, want: 4, capacity: 4, pid: 101, alive: () => true });
    expect(first.held).toBe(4);
    let clock = 0;
    const second = await acquireSlots({
      dir,
      want: 4,
      capacity: 4,
      pid: 202,
      alive: () => true,
      waitMs: 1000,
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });
    // It waited the whole window, then ran ONE worker unleased — never four beside four.
    expect(second.held).toBe(0);
    expect(second.count).toBe(1);
    expect(second.waitedMs).toBeGreaterThanOrEqual(1000);
    first.release();
  });

  test('two runs split the capacity: the second runs narrower', async () => {
    const dir = fresh();
    const first = await acquireSlots({ dir, want: 3, capacity: 4, pid: 101, alive: () => true });
    const second = await acquireSlots({ dir, want: 4, capacity: 4, pid: 202, alive: () => true });
    expect(first.count).toBe(3);
    expect(second.count).toBe(1);
    first.release();
    second.release();
    expect(readdirSync(dir)).toEqual([]);
  });

  test('a dead holder’s slot is taken over', async () => {
    const dir = fresh();
    writeFileSync(join(dir, 'slot-0'), '999999');
    writeFileSync(join(dir, 'slot-1'), '101');
    const lease = await acquireSlots({
      dir,
      want: 2,
      capacity: 2,
      pid: 202,
      alive: (pid) => pid === 101,
      sleep: noSleep,
    });
    expect(lease.held).toBe(1);
    lease.release();
    // Only its own slot is released; the live holder's file is untouched.
    expect(readdirSync(dir)).toEqual(['slot-1']);
  });

  test('release is idempotent and a lease is never wider than asked', async () => {
    const dir = fresh();
    const lease = await acquireSlots({ dir, want: 2, capacity: 8, pid: 7, alive: () => true });
    expect(lease.count).toBe(2);
    lease.release();
    lease.release();
    expect(readdirSync(dir)).toEqual([]);
  });

  test('the directory and the off switch read from the environment', () => {
    expect(slotsDir({ ULTIMATE_TEST_SLOTS_DIR: '/x/y' })).toBe('/x/y');
    expect(slotsEnabled({ ULTIMATE_TEST_SLOTS: '0' })).toBe(false);
    expect(slotsEnabled({ ULTIMATE_TEST_SLOT_HELD: '1' })).toBe(false);
    if (Bun.env['ULTIMATE_TEST_SLOT_HELD'] !== '1') expect(slotsEnabled({})).toBe(true);
  });
});
