// Two runs share one checkout's caches: a scaffold another run cached first is used as it stands,
// and a run removes only the loopback install-cache entries that appeared while it ran.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp, mkdir or recursive remove.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { adoptInto, loopbackEntries, purgeLoopbackEntries } from './upgrade-fixtures-cache';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'upgrade-fixtures-cache-'));
  dirs.push(dir);
  return dir;
};

describe('upgrade-fixtures caches', () => {
  test('a scaffold another run cached first wins, and this run`s copy is dropped', async () => {
    const dir = temp();
    const cached = join(dir, 'cache', 'fxapp');
    mkdirSync(cached, { recursive: true });
    await Bun.write(join(cached, 'package.json'), 'theirs');
    const mine = join(dir, 'mine');
    mkdirSync(mine);
    await Bun.write(join(mine, 'package.json'), 'mine');
    expect(adoptInto(mine, cached)).toBe(cached);
    expect(await Bun.file(join(cached, 'package.json')).text()).toBe('theirs');

    expect(await Bun.file(join(mine, 'package.json')).exists()).toBe(false);
    mkdirSync(mine);
    await Bun.write(join(mine, 'package.json'), 'mine');
    const fresh = join(dir, 'cache2', 'fxapp');
    mkdirSync(join(dir, 'cache2'));
    expect(adoptInto(mine, fresh)).toBe(fresh);
    expect(await Bun.file(join(fresh, 'package.json')).text()).toBe('mine');
  });

  test('only the loopback entries that appeared during this run are purged', () => {
    const cache = temp();
    const scope = join(cache, '@ultimat3');
    for (const entry of [
      'core@31.26.0@@@1',
      'core@31.28.0@@127.0.0.1__aaaa@@@1',
      'core@31.28.0@@127.0.0.1__bbbb@@@1',
    ]) {
      mkdirSync(join(scope, entry), { recursive: true });
    }
    const before = loopbackEntries(cache);
    expect(before).toEqual([
      'core@31.28.0@@127.0.0.1__aaaa@@@1',
      'core@31.28.0@@127.0.0.1__bbbb@@@1',
    ]);
    mkdirSync(join(scope, 'core@31.28.0@@127.0.0.1__cccc@@@1'));
    expect(purgeLoopbackEntries(cache, new Set(before))).toEqual([
      'core@31.28.0@@127.0.0.1__cccc@@@1',
    ]);
    expect(loopbackEntries(cache)).toEqual(before);
    expect(purgeLoopbackEntries(join(cache, 'none'), new Set())).toEqual([]);
  });
});
