// Single responsibility: a fresh boot is handed back READY. PGlite 0.5.10 moved `dumpDataDir` and
// `close` inside its query mutex, so either, asked of an instance still running `initdb`, waits for
// a readiness that never comes — `x db gen` spun until CI killed it. The fake below behaves exactly
// that way, so the ordering is pinned without the WASM build.

import { afterEach, beforeEach, expect, test } from 'bun:test';
// why: Bun has no temp-directory API, no directory listing and no recursive remove.
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir().
import { tmpdir } from 'node:os';
// why: Bun ships no path joiner.
import { join } from 'node:path';
import { loadPgliteDriver, type PgliteDriver } from './pglite';
import { forgetSnapshot, snapshotKey } from './pglite-snapshot';

const VERSION = '9.9.10';
let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'x-pglite-ready-'));
});

afterEach(() => {
  forgetSnapshot(snapshotKey(VERSION));
  rmSync(dir, { recursive: true, force: true });
});

/** PGlite 0.5.10's shape: a statement awaits readiness; a dump or a close before it never settles. */
class HangsBeforeReady implements PgliteDriver {
  private ready = false;
  async query(): Promise<{ rows: readonly unknown[] }> {
    await Bun.sleep(5);
    this.ready = true;
    return { rows: [] };
  }
  dumpDataDir(): Promise<Blob> {
    if (!this.ready) return new Promise<Blob>(() => undefined);
    return Promise.resolve(new Blob(['fresh initdb']));
  }
  close(): Promise<void> {
    if (!this.ready) return new Promise<void>(() => undefined);
    return Promise.resolve();
  }
}

const load = async () => ({ PGlite: HangsBeforeReady });
const within = <T>(work: Promise<T>, late: T): Promise<T> =>
  Promise.race([work, Bun.sleep(1_000).then(() => late)]);

test('a fresh boot is ready before its snapshot is dumped, so the boot settles and is cached', async () => {
  const booted = loadPgliteDriver({ load, snapshotDir: dir, version: async () => VERSION });
  expect(
    await within(
      booted.then(() => 'booted'),
      'still dumping',
    ),
  ).toBe('booted');
  expect(readdirSync(dir)).toHaveLength(1);
});

test('a boot with no cache is ready too, so closing it before any statement settles', async () => {
  const driver = await loadPgliteDriver({ load });
  expect(
    await within(
      driver.close().then(() => 'closed'),
      'still closing',
    ),
  ).toBe('closed');
});

test('a boot that never becomes ready is handed back uncached, for its first statement to report', async () => {
  class NeverReady implements PgliteDriver {
    // Input to the loader: what PGlite answers when `initdb` itself failed.
    query = (): Promise<{ rows: readonly unknown[] }> => Promise.reject(new Error('initdb failed'));
    dumpDataDir = (): Promise<Blob> => Promise.resolve(new Blob(['half a cluster']));
    close = (): Promise<void> => Promise.resolve();
  }
  const driver = await loadPgliteDriver({
    load: async () => ({ PGlite: NeverReady }),
    snapshotDir: dir,
    version: async () => VERSION,
  });
  expect(readdirSync(dir)).toEqual([]);
  await expect(driver.query('select 1')).rejects.toThrow('initdb failed');
});
