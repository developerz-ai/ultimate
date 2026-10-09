// Single responsibility: the snapshot cache is never trusted — a file is read only through its
// checksum, anything unsound is deleted and rebuilt, a version or extension change misses, and
// two writers racing leave one whole file. The boot that uses it is driven through a fake PGlite,
// so no test here pays for the `initdb` the cache exists to skip.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun has no temp-directory API, no directory listing, no recursive remove, no chmod, no utimes.
import { chmodSync, mkdtempSync, readdirSync, rmSync, utimesSync } from 'node:fs';
// why: Bun exposes no tmpdir().
import { tmpdir } from 'node:os';
// why: Bun ships no path joiner.
import { join } from 'node:path';
import { loadPgliteDriver, type PgliteDriver } from './pglite';
import {
  forgetSnapshot,
  pgliteVersion,
  readSnapshot,
  snapshotFile,
  snapshotKey,
  writeSnapshot,
} from './pglite-snapshot';

const blobOf = (text: string): Blob => new Blob([text]);
const textOf = async (blob: Blob | undefined): Promise<string | undefined> =>
  blob === undefined ? undefined : blob.text();

let dir = '';
/** Every key a test touched, so the process-wide memo is empty again for the next one. */
const keys = new Set<string>();
const keyFor = (version: string): string => {
  const key = snapshotKey(version);
  keys.add(key);
  return key;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'x-pglite-snapshot-'));
});

afterEach(() => {
  for (const key of keys) forgetSnapshot(key);
  keys.clear();
  rmSync(dir, { recursive: true, force: true });
});

describe('snapshotKey', () => {
  test('a version change is another key', () => {
    expect(snapshotKey('0.5.9')).not.toBe(snapshotKey('0.5.8'));
    expect(snapshotKey('0.5.8')).toStartWith('0.5.8-');
  });
});

describe('readSnapshot / writeSnapshot', () => {
  test('what was written is what is read back, from disk, by another process’s eyes', async () => {
    const key = keyFor('1.0.0');
    const file = snapshotFile(dir, key);
    await writeSnapshot(file, key, blobOf('tarball bytes'));
    forgetSnapshot(key);
    expect(await textOf(await readSnapshot(file, key))).toBe('tarball bytes');
  });

  test('an absent file is a miss', async () => {
    const key = keyFor('1.0.0');
    expect(await readSnapshot(snapshotFile(dir, key), key)).toBeUndefined();
  });

  test('a corrupt file is discarded, never trusted: one flipped byte, a truncation, a foreign file', async () => {
    const key = keyFor('1.0.0');
    const file = snapshotFile(dir, key);
    await writeSnapshot(file, key, blobOf('tarball bytes'));
    const sound = new Uint8Array(await Bun.file(file).arrayBuffer());
    const flipped = sound.slice();
    flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 0xff;
    for (const bytes of [flipped, sound.slice(0, sound.length - 3), new Uint8Array(200)]) {
      await Bun.write(file, bytes);
      forgetSnapshot(key);
      expect(await readSnapshot(file, key)).toBeUndefined();
      // Deleted, so the next boot rebuilds it instead of re-reading a file that never verifies.
      expect(await Bun.file(file).exists()).toBe(false);
    }
  });

  test('a file that exists and cannot be read is a miss, never a failed boot', async () => {
    const key = keyFor('1.0.0');
    const file = snapshotFile(dir, key);
    await writeSnapshot(file, key, blobOf('tarball bytes'));
    forgetSnapshot(key);
    // `exists()` and the read are two calls: what lands between them is any read failure.
    chmodSync(file, 0o000);
    expect(await readSnapshot(file, key)).toBeUndefined();
  });

  test('two writers racing leave one whole, verifiable file and no temp file', async () => {
    const key = keyFor('1.0.0');
    const file = snapshotFile(dir, key);
    const big = 'x'.repeat(2_000_000);
    await Promise.all(
      Array.from({ length: 8 }, (_, at) => writeSnapshot(file, key, blobOf(`${at}:${big}`))),
    );
    forgetSnapshot(key);
    const read = await textOf(await readSnapshot(file, key));
    // Whichever writer won, its bytes are all there — never a splice of two.
    expect(read).toMatch(/^[0-7]:x+$/);
    expect(read?.length).toBe(big.length + 2);
    expect(readdirSync(dir)).toEqual([`pglite-${key}.snapshot`]);
  });

  test('a directory that cannot be written costs nothing but the cache', async () => {
    const key = keyFor('1.0.0');
    // A FILE where the directory should be: `createPath` cannot make it.
    await Bun.write(join(dir, 'blocked'), 'not a directory');
    const file = snapshotFile(join(dir, 'blocked'), key);
    await writeSnapshot(file, key, blobOf('bytes'));
    forgetSnapshot(key);
    expect(await readSnapshot(file, key)).toBeUndefined();
  });
});

// #738: one snapshot per PGlite version, and nothing evicted the last version's — a cache that
// only grows. Writing one keeps it and the newest previous one (a second checkout may still be on
// the older PGlite), and the rest go.
describe('writeSnapshot evicts the snapshots of older versions', () => {
  test('the current one and the newest previous one stay; older ones and other files are kept apart', async () => {
    for (const [index, version] of ['0.1.0', '0.2.0', '0.3.0'].entries()) {
      await writeSnapshot(snapshotFile(dir, keyFor(version)), keyFor(version), blobOf(version));
      // Distinct mtimes, oldest first, whatever the filesystem's resolution.
      const at = (Date.now() - (3 - index) * 60_000) / 1000;
      utimesSync(snapshotFile(dir, keyFor(version)), at, at);
    }
    await Bun.write(join(dir, 'unrelated.txt'), 'kept');
    await writeSnapshot(snapshotFile(dir, keyFor('0.4.0')), keyFor('0.4.0'), blobOf('0.4.0'));
    expect(readdirSync(dir).sort()).toEqual(
      [
        snapshotFile(dir, keyFor('0.3.0')),
        snapshotFile(dir, keyFor('0.4.0')),
        join(dir, 'unrelated.txt'),
      ]
        .map((path) => path.slice(dir.length + 1))
        .sort(),
    );
  });
});

describe('pgliteVersion', () => {
  test('reads the installed package’s own manifest', async () => {
    expect(await pgliteVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  test('a package that will not resolve has no version, which disables caching', async () => {
    expect(await pgliteVersion(() => 'file:///nowhere/dist/index.js')).toBeUndefined();
    // Not a URL at all: what a resolver answers when it has nothing to resolve to.
    expect(await pgliteVersion(() => 'not a url')).toBeUndefined();
  });
});

/** A fake PGlite: records every construction, and refuses the snapshots it is told to refuse. */
function fakePglite(refuse: (snapshot: string) => boolean = () => false) {
  const boots: { readonly restored: string | undefined }[] = [];
  let closed = 0;
  class Fake implements PgliteDriver {
    private readonly ready: Promise<string | undefined>;
    constructor(_dataDir: unknown, options: { readonly loadDataDir?: Blob } = {}) {
      this.ready =
        options.loadDataDir === undefined ? Promise.resolve(undefined) : options.loadDataDir.text();
      void this.ready.then((restored) => boots.push({ restored }));
    }
    async query(): Promise<{ rows: readonly unknown[] }> {
      const restored = await this.ready;
      // Input to the loader: what PGlite does with a tarball it cannot open.
      if (restored !== undefined && refuse(restored))
        return Promise.reject(new Error('inflate failed'));
      return { rows: [] };
    }
    async dumpDataDir(): Promise<Blob> {
      return blobOf('fresh initdb');
    }
    async close(): Promise<void> {
      closed += 1;
    }
  }
  return { boots, closedCount: () => closed, load: async () => ({ PGlite: Fake }) };
}

describe('loadPgliteDriver · snapshotDir', () => {
  const version = (value: string | undefined) => async () => value;

  test('the first boot runs initdb and writes the snapshot; the next restores from it', async () => {
    keyFor('9.9.1');
    const fake = fakePglite();
    await loadPgliteDriver({ load: fake.load, snapshotDir: dir, version: version('9.9.1') });
    await loadPgliteDriver({ load: fake.load, snapshotDir: dir, version: version('9.9.1') });
    expect(fake.boots).toEqual([{ restored: undefined }, { restored: 'fresh initdb' }]);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  test('another process restores from the FILE: the memo is not what makes it work', async () => {
    const key = keyFor('9.9.2');
    const fake = fakePglite();
    await loadPgliteDriver({ load: fake.load, snapshotDir: dir, version: version('9.9.2') });
    forgetSnapshot(key);
    await loadPgliteDriver({ load: fake.load, snapshotDir: dir, version: version('9.9.2') });
    expect(fake.boots.at(-1)).toEqual({ restored: 'fresh initdb' });
  });

  test('a version change misses the cache and builds its own', async () => {
    keyFor('9.9.3');
    keyFor('9.9.4');
    const fake = fakePglite();
    await loadPgliteDriver({ load: fake.load, snapshotDir: dir, version: version('9.9.3') });
    await loadPgliteDriver({ load: fake.load, snapshotDir: dir, version: version('9.9.4') });
    expect(fake.boots).toEqual([{ restored: undefined }, { restored: undefined }]);
    expect(readdirSync(dir)).toHaveLength(2);
  });

  test('a snapshot that verifies and still will not open is discarded, and the boot is a fresh one', async () => {
    const key = keyFor('9.9.5');
    const file = snapshotFile(dir, key);
    await writeSnapshot(file, key, blobOf('stale'));
    const fake = fakePglite((snapshot) => snapshot === 'stale');
    const driver = await loadPgliteDriver({
      load: fake.load,
      snapshotDir: dir,
      version: version('9.9.5'),
    });
    await driver.query('select 1');
    // Tried, refused, closed — then a real boot, whose snapshot replaced the bad one.
    expect(fake.boots).toEqual([{ restored: 'stale' }, { restored: undefined }]);
    expect(fake.closedCount()).toBe(1);
    forgetSnapshot(key);
    expect(await textOf(await readSnapshot(file, key))).toBe('fresh initdb');
  });

  test('the refused snapshot is deleted even when this boot cannot write a new one', async () => {
    // Without this the next boot reads the same bad file, is refused the same way, and pays for
    // the failed restore every time.
    const key = keyFor('9.9.7');
    const file = snapshotFile(dir, key);
    await writeSnapshot(file, key, blobOf('stale'));
    const fake = fakePglite(() => true);
    const load = async () => {
      const module = await fake.load();
      // A PGlite build with no `dumpDataDir`: the fresh boot has nothing to write back.
      Object.defineProperty(module.PGlite.prototype, 'dumpDataDir', { value: undefined });
      return module;
    };
    await loadPgliteDriver({ load, snapshotDir: dir, version: version('9.9.7') });
    expect(readdirSync(dir)).toEqual([]);
  });

  test('one snapshot serves every extension set: a boot that links one restores the plain one', async () => {
    keyFor('9.9.8');
    const fake = fakePglite();
    await loadPgliteDriver({ load: fake.load, snapshotDir: dir, version: version('9.9.8') });
    await loadPgliteDriver({
      load: fake.load,
      snapshotDir: dir,
      version: version('9.9.8'),
      extensions: ['citext'],
      loadExtension: async () => ({ citext: { name: 'citext' } }),
    });
    expect(fake.boots).toEqual([{ restored: undefined }, { restored: 'fresh initdb' }]);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  test('no version, no directory, or a data directory on disk: no cache is read or written', async () => {
    const fake = fakePglite();
    await loadPgliteDriver({ load: fake.load, snapshotDir: dir, version: version(undefined) });
    await loadPgliteDriver({ load: fake.load, version: version('9.9.6') });
    await loadPgliteDriver({
      load: fake.load,
      snapshotDir: dir,
      dataDir: join(dir, 'pgdata'),
      version: version('9.9.6'),
    });
    expect(fake.boots.every((boot) => boot.restored === undefined)).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });
});
