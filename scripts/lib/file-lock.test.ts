// The lock `bun run typecheck:locked` serialises `tsc -b` with: one holder at a time, a dead
// holder's file taken over, and a release that never removes a lock someone else now holds.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: a throwaway directory per test; Bun ships no temp-dir primitive.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, pidAlive } from './file-lock';

let dir = '';
let lock = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'file-lock-'));
  lock = join(dir, 'tsc.lock');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const noSleep = () => Promise.resolve();

describe('unit · an exclusive lock file held by a pid', () => {
  test('a free lock is taken at once, written with our pid, and released', async () => {
    const release = await acquireLock(lock, { pid: 111, isAlive: () => true, sleep: noSleep });
    expect(readFileSync(lock, 'utf8')).toBe('111');
    release();
    expect(existsSync(lock)).toBe(false);
  });

  test('a lock a LIVE process holds is waited on, and taken once it is released', async () => {
    writeFileSync(lock, '222');
    const waitedOn: number[] = [];
    let polls = 0;
    const release = await acquireLock(lock, {
      pid: 111,
      isAlive: () => true,
      onWait: (holder) => waitedOn.push(holder),
      sleep: () => {
        polls += 1;
        if (polls === 3) rmSync(lock); // the holder finishes
        return Promise.resolve();
      },
    });
    expect(polls).toBe(3);
    expect(waitedOn).toEqual([222]); // told once, not once per poll
    expect(readFileSync(lock, 'utf8')).toBe('111');
    release();
  });

  test('a DEAD holder is taken over without waiting', async () => {
    writeFileSync(lock, '333');
    const release = await acquireLock(lock, {
      pid: 111,
      isAlive: (pid) => pid !== 333,
      sleep: () => expect.unreachable('a dead holder is never waited on'),
    });
    expect(readFileSync(lock, 'utf8')).toBe('111');
    release();
  });

  test('a file with no pid in it — a writer killed mid-create — is stale too', async () => {
    writeFileSync(lock, '');
    const release = await acquireLock(lock, {
      pid: 111,
      isAlive: () => true,
      sleep: () => expect.unreachable('an empty lock is never waited on'),
    });
    expect(readFileSync(lock, 'utf8')).toBe('111');
    release();
  });

  test('a release never removes a lock another process now holds', async () => {
    const release = await acquireLock(lock, { pid: 111, isAlive: () => true, sleep: noSleep });
    writeFileSync(lock, '444'); // taken over after we were presumed dead
    release();
    expect(readFileSync(lock, 'utf8')).toBe('444');
  });

  test('pidAlive answers this process live and an unused pid dead', () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(2 ** 22 + 12_345)).toBe(false);
  });
});
