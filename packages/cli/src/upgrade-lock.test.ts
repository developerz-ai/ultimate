// One `x upgrade` per app at a time: a second is refused naming the holder, a lock whose holder is
// gone is taken over, and a release removes only the lock this run wrote.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { processStartTime } from './dev-lock-identity';
import { acquireUpgradeLock, UPGRADE_LOCK_FILE } from './upgrade-lock';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const app = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'upgrade-lock-'));
  dirs.push(dir);
  return dir;
};

describe('unit · x upgrade, the lock', () => {
  test('a second hop in the same app is refused, naming the holder and where it is held', async () => {
    const dir = app();
    const release = await acquireUpgradeLock(dir);
    try {
      await expect(
        acquireUpgradeLock(dir, { alive: () => true, pid: process.pid + 1 }),
      ).rejects.toMatchObject({ code: 'X_UPGRADE_LOCKED' });
      try {
        await acquireUpgradeLock(dir, { alive: () => true, pid: process.pid + 1 });
        expect.unreachable('a live holder is refused');
      } catch (error) {
        expect(String((error as { cause?: unknown }).cause)).toContain(String(process.pid));
        expect(String((error as { fix?: unknown }).fix)).toContain(`ps -p ${process.pid}`);
      }
    } finally {
      release();
    }
    expect(Bun.file(join(dir, UPGRADE_LOCK_FILE)).size).toBe(0);
  });

  test('a lock whose holder is dead is taken over', async () => {
    const dir = app();
    mkdirSync(join(dir, '.x'), { recursive: true });
    await Bun.write(
      join(dir, UPGRADE_LOCK_FILE),
      JSON.stringify({ pid: 999_999_999, startedAt: '' }),
    );
    const release = await acquireUpgradeLock(dir, { alive: (pid) => pid === process.pid });
    const held = (await Bun.file(join(dir, UPGRADE_LOCK_FILE)).json()) as { pid: number };
    expect(held.pid).toBe(process.pid);
    release();
    expect(await Bun.file(join(dir, UPGRADE_LOCK_FILE)).exists()).toBe(false);
  });

  test('a lock whose pid the kernel handed to another process is taken over', async () => {
    const dir = app();
    mkdirSync(join(dir, '.x'), { recursive: true });
    // A hop killed with -9: its pid now names a live process that started at another time.
    const reused = process.ppid;
    expect(await processStartTime(reused)).toBeDefined();
    await Bun.write(
      join(dir, UPGRADE_LOCK_FILE),
      JSON.stringify({ pid: reused, startedAt: '2020-01-01T00:00:00.000Z', started: '1' }),
    );
    const release = await acquireUpgradeLock(dir);
    const held = (await Bun.file(join(dir, UPGRADE_LOCK_FILE)).json()) as { pid: number };
    expect(held.pid).toBe(process.pid);
    release();
  });

  test.skipIf(process.platform === 'win32')(
    "the lock records its holder's OS start time, so a live holder is still refused",
    async () => {
      const dir = app();
      const release = await acquireUpgradeLock(dir);
      try {
        const held = (await Bun.file(join(dir, UPGRADE_LOCK_FILE)).json()) as {
          started?: string;
        };
        expect(held.started).toBe(await processStartTime(process.pid));
        await expect(acquireUpgradeLock(dir, { pid: process.pid + 1 })).rejects.toMatchObject({
          code: 'X_UPGRADE_LOCKED',
        });
      } finally {
        release();
      }
    },
  );

  test('a release never removes a lock another run has since written', async () => {
    const dir = app();
    const release = await acquireUpgradeLock(dir);
    const theirs = JSON.stringify({ pid: process.pid + 1, startedAt: 'later' });
    await Bun.write(join(dir, UPGRADE_LOCK_FILE), theirs);
    release();
    expect(await Bun.file(join(dir, UPGRADE_LOCK_FILE)).text()).toBe(theirs);
  });
});
