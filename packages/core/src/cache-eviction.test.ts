// A content-keyed cache file is written once per key and never read again once the key moves on:
// an app's `.x/test-db` held 72 migrated templates, 4.2 GB, one per migration state (#738). Writing
// a new one evicts the rest down to the current key and the newest previous one — the previous one
// because a second checkout or a run still on the old migrations may be reading it right now.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp, no utimes and no recursive remove.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path joiner.
import { join } from 'node:path';
import { evictCacheFiles } from './cache-eviction';

const scratch = mkdtempSync(join(tmpdir(), 'x-cache-evict-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const isTemplate = (name: string): boolean => /^pglite-[0-9a-f]+\.tar$/.test(name);
const isTemp = (name: string): boolean => name.endsWith('.partial');

/** A fresh directory holding each named file, last modified `age` ms before `NOW`. */
function seeded(name: string, files: Readonly<Record<string, number>>): string {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  for (const [file, age] of Object.entries(files)) {
    writeFileSync(join(dir, file), file);
    const at = (NOW - age) / 1000;
    utimesSync(join(dir, file), at, at);
  }
  return dir;
}

describe('evictCacheFiles', () => {
  test('keeps the current file and the newest previous one; the rest go', async () => {
    const dir = seeded('a', {
      'pglite-aa.tar': 0,
      'pglite-bb.tar': 5 * MIN,
      'pglite-cc.tar': 60 * MIN,
      'pglite-dd.tar': 600 * MIN,
    });
    const removed = await evictCacheFiles({
      dir,
      current: 'pglite-aa.tar',
      matches: isTemplate,
      now: () => NOW,
    });
    expect(readdirSync(dir).sort()).toEqual(['pglite-aa.tar', 'pglite-bb.tar']);
    expect([...removed].sort()).toEqual([join(dir, 'pglite-cc.tar'), join(dir, 'pglite-dd.tar')]);
  });

  test('never the current file, even when it is the oldest; a file it does not match stays', async () => {
    const dir = seeded('b', {
      'pglite-aa.tar': 900 * MIN,
      'pglite-bb.tar': MIN,
      'pglite-cc.tar': 2 * MIN,
      'notes.txt': 999 * MIN,
    });
    await evictCacheFiles({ dir, current: 'pglite-aa.tar', matches: isTemplate, now: () => NOW });
    expect(readdirSync(dir).sort()).toEqual(['notes.txt', 'pglite-aa.tar', 'pglite-bb.tar']);
  });

  test('a half-written temp file goes once it is too old to be a write in flight', async () => {
    const dir = seeded('c', { 'pglite-aa.tar': 0, 'x.1.partial': 30 * MIN, 'y.2.partial': MIN });
    await evictCacheFiles({
      dir,
      current: 'pglite-aa.tar',
      matches: isTemplate,
      temporary: isTemp,
      now: () => NOW,
    });
    expect(readdirSync(dir).sort()).toEqual(['pglite-aa.tar', 'y.2.partial']);
  });

  test('`keepPrevious: 0` keeps the current file alone; a missing directory is nothing to do', async () => {
    const dir = seeded('d', { 'pglite-aa.tar': 0, 'pglite-bb.tar': MIN });
    await evictCacheFiles({ dir, current: 'pglite-aa.tar', matches: isTemplate, keepPrevious: 0 });
    expect(readdirSync(dir)).toEqual(['pglite-aa.tar']);
    const absent = join(scratch, 'absent');
    expect(await evictCacheFiles({ dir: absent, current: 'x', matches: isTemplate })).toEqual([]);
  });

  test('no current file and `keepPrevious: 0` empties it of matches — what `x clean` asks', async () => {
    const dir = seeded('e', { 'pglite-aa.tar': 0, 'pglite-bb.tar': MIN });
    await evictCacheFiles({ dir, current: undefined, matches: isTemplate, keepPrevious: 0 });
    expect(readdirSync(dir)).toEqual([]);
  });

  test('`dryRun` names what it would remove and removes nothing', async () => {
    const dir = seeded('f', { 'pglite-aa.tar': 0, 'pglite-bb.tar': MIN, 'pglite-cc.tar': 2 * MIN });
    const named = await evictCacheFiles({
      dir,
      current: 'pglite-aa.tar',
      matches: isTemplate,
      dryRun: true,
      now: () => NOW,
    });
    expect(named).toEqual([join(dir, 'pglite-cc.tar')]);
    expect(readdirSync(dir).length).toBe(3);
  });
});
