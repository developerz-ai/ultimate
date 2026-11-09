// The stale-lock steal, alone: under `dev.lock.steal` it removes exactly the bytes judged stale, a
// lock that changed since it was read is left as it was, a live guard holds it off, and a guard a
// crashed steal left behind is taken over rather than blocking every later boot.

import { describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp, recursive remove, directory listing, stat, link or sync write.
import {
  linkSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { STEAL_GUARD_STALE_MS, STEAL_GUARD_SUFFIX, stealStale } from './dev-lock-steal';

const STALE = '{"pid":4242,"port":3000}\n';
const FRESH = '{"pid":7777,"port":3000}\n';
const MINE = `{"pid":${process.pid},"port":3000}\n`;

/** The exclusive create `dev-lock.ts` hands in: staged, then linked. */
const claim =
  (dir: string) =>
  (path: string): boolean => {
    const staged = join(dir, `staged-${crypto.randomUUID()}`);
    writeFileSync(staged, MINE);
    try {
      linkSync(staged, path);
      return true;
    } catch {
      return false;
    } finally {
      unlinkSync(staged);
    }
  };

const inDir = async (body: (dir: string, path: string) => Promise<void>): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), 'ultimate-dev-lock-steal-'));
  try {
    await body(dir, join(dir, 'dev.lock'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const steal = (dir: string, path: string, alive: (pid: number) => boolean, now?: () => number) =>
  stealStale({
    path,
    judged: STALE,
    claim: claim(dir),
    alive,
    ...(now === undefined ? {} : { now }),
  });

describe('stealStale', () => {
  test('the lock judged stale is taken, and the guard is given back', async () => {
    await inDir(async (dir, path) => {
      writeFileSync(path, STALE);
      expect(steal(dir, path, () => true)).toBe('cleared');
      expect(readdirSync(dir)).toEqual([]);
    });
  });

  test('a lock re-claimed since it was read is left byte for byte, and nothing else left', async () => {
    await inDir(async (dir, path) => {
      writeFileSync(path, FRESH);
      expect(steal(dir, path, () => true)).toBe('changed');
      expect(readdirSync(dir)).toEqual(['dev.lock']);
      expect(await Bun.file(path).text()).toBe(FRESH);
    });
  });

  test('a lock already gone is cleared: the claim that follows decides', async () => {
    await inDir(async (dir, path) => {
      expect(steal(dir, path, () => true)).toBe('cleared');
      expect(readdirSync(dir)).toEqual([]);
    });
  });

  test('a live guard means another boot is clearing it: busy, and the lock is untouched', async () => {
    await inDir(async (dir, path) => {
      writeFileSync(path, STALE);
      writeFileSync(`${path}${STEAL_GUARD_SUFFIX}`, MINE);
      expect(steal(dir, path, () => true)).toBe('busy');
      expect(await Bun.file(path).text()).toBe(STALE);
      expect(await Bun.file(`${path}${STEAL_GUARD_SUFFIX}`).text()).toBe(MINE);
    });
  });

  test('a guard whose pid is gone is taken over, and the stale lock cleared', async () => {
    await inDir(async (dir, path) => {
      writeFileSync(path, STALE);
      writeFileSync(`${path}${STEAL_GUARD_SUFFIX}`, MINE);
      expect(steal(dir, path, (pid) => pid !== process.pid)).toBe('cleared');
      expect(readdirSync(dir)).toEqual([]);
    });
  });

  test('a guard older than any steal is taken over, whatever its pid says', async () => {
    await inDir(async (dir, path) => {
      writeFileSync(path, STALE);
      writeFileSync(`${path}${STEAL_GUARD_SUFFIX}`, MINE);
      // Against the file's own mtime: the test preload may hold the clock still.
      const written = statSync(`${path}${STEAL_GUARD_SUFFIX}`).mtimeMs;
      const later = () => written + STEAL_GUARD_STALE_MS + 1_000;
      expect(steal(dir, path, () => true, later)).toBe('cleared');
      expect(readdirSync(dir)).toEqual([]);
    });
  });
});
