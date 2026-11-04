// The retention window over a real (memory) disk: a publish is idempotent, the sweep keeps the
// newest `builds` and only what they name, the manifest follows the files, an oversized file is
// skipped and said once, and two apps or environments on one disk never touch each other.

import { describe, expect, test } from 'bun:test';
import type { FrozenClock } from '@ultimat3/core';
import { frozenClock } from '@ultimat3/core';
import type { StorageBody, StorageDriver } from '@ultimat3/storage';
import { memoryStorageDriver, StorageError } from '@ultimat3/storage';
import type { BuildAsset, RetainLog } from './retained-assets';
import { publishBuildAssets } from './retained-assets';
import { manifestKey, retainedFileKey, retainedPrefix } from './retained-assets-layout';

const PREFIX = retainedPrefix('app', 'production');
const fileKey = (url: string): string => retainedFileKey(PREFIX, url);
const mkey = (buildId: string): string => manifestKey(PREFIX, buildId);
/** Past the sweep's grace, so a file the sweep may delete is old enough to be deleted. */
const HOUR = 3_600_000;

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const css = (url: string, body: string): BuildAsset => ({
  url,
  contentType: 'text/css; charset=utf-8',
  body: text(body),
});

interface Logged {
  readonly level: 'warn' | 'error';
  readonly message: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

const recorder = (): { readonly log: RetainLog; readonly lines: Logged[] } => {
  const lines: Logged[] = [];
  return {
    lines,
    log: {
      warn: (message, fields) => lines.push({ level: 'warn', message, fields }),
      error: (message, fields) => lines.push({ level: 'error', message, fields }),
    },
  };
};

/** A disk that counts what it was asked, and lets a test intercept one `put`. */
const counted = (
  disk: StorageDriver,
  onPut: (key: string) => Promise<void> = async () => undefined,
): { readonly disk: StorageDriver; readonly calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    disk: {
      ...disk,
      put: async (key: string, body: StorageBody, options) => {
        calls.push(`put ${key}`);
        await onPut(key);
        return disk.put(key, body, options);
      },
      exists: async (key: string) => {
        calls.push(`exists ${key}`);
        return disk.exists(key);
      },
      stat: async (key: string) => {
        calls.push(`stat ${key}`);
        return disk.stat(key);
      },
      delete: async (key: string) => {
        calls.push(`delete ${key}`);
        return disk.delete(key);
      },
    },
  };
};

const keysOf = async (disk: StorageDriver): Promise<readonly string[]> =>
  (await disk.list({ prefix: 'x-build-assets/' })).rows.map((entry) => entry.key).sort();

const publish = (
  disk: StorageDriver,
  clock: FrozenClock,
  buildId: string,
  assets: readonly BuildAsset[],
  log: RetainLog = recorder().log,
) =>
  publishBuildAssets({
    disk,
    prefix: PREFIX,
    diskName: 'assets',
    buildId,
    builds: 2,
    assets,
    clock,
    log,
  });

describe('publishBuildAssets', () => {
  test('a second publish of one build puts no file again: it re-dates the manifest only', async () => {
    const clock = frozenClock('2026-11-03T00:00:00Z');
    const { disk, calls } = counted(memoryStorageDriver({ clock }));
    const assets = [css('/styles/aaaaaaaa.css', 'a{}'), css('/styles/bbbbbbbb.css', 'b{}')];

    expect((await publish(disk, clock, 'b1', assets)).outcome).toBe('published');
    calls.length = 0;
    const again = await publish(disk, clock, 'b1', assets);

    expect(again).toEqual({ outcome: 'present', put: 0, skipped: [], swept: 0 });
    expect(calls.filter((call) => call.startsWith('put '))).toEqual([`put ${mkey('b1')}`]);
  });

  test('builds: 2 after three publishes deletes the file unique to the oldest, and nothing else', async () => {
    const clock = frozenClock('2026-11-03T00:00:00Z');
    const disk = memoryStorageDriver({ clock });
    const shared = css('/styles/5a5a5a5a.css', 'shared{}');

    await publish(disk, clock, 'b1', [shared, css('/islands/one-11111111.js', 'one')]);
    clock.advance(HOUR);
    await publish(disk, clock, 'b2', [shared, css('/islands/two-22222222.js', 'two')]);
    clock.advance(HOUR);
    const third = await publish(disk, clock, 'b3', [
      shared,
      css('/islands/six-33333333.js', 'six'),
    ]);

    expect(third.swept).toBe(1);
    expect(await keysOf(disk)).toEqual(
      [
        mkey('b2'),
        mkey('b3'),
        fileKey('/islands/six-33333333.js'),
        fileKey('/islands/two-22222222.js'),
        fileKey('/styles/5a5a5a5a.css'),
      ].sort(),
    );
  });

  test('the manifest is written last: a disk refusing it leaves the files, no manifest, and a coded line', async () => {
    const clock = frozenClock('2026-11-03T00:00:00Z');
    const memory = memoryStorageDriver({ clock });
    const refusing = counted(memory, async (key) => {
      if (key === mkey('b1')) {
        throw new StorageError({
          code: 'X_STORAGE_PUT_FAILED',
          cause: 'the bucket refused the manifest',
          fix: 'x doctor --json',
        });
      }
    });
    const { log, lines } = recorder();

    const report = await publish(
      refusing.disk,
      clock,
      'b1',
      [css('/styles/aaaaaaaa.css', 'a')],
      log,
    );

    expect(report.outcome).toBe('failed');
    expect(await memory.exists(fileKey('/styles/aaaaaaaa.css'))).toBe(true);
    expect(await memory.exists(mkey('b1'))).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'error',
      message: 'X_ASSET_RETAIN_FAILED',
      fields: { code: 'X_ASSET_RETAIN_FAILED', fix: 'x doctor --json', disk: 'assets' },
    });
    expect(String(lines[0]?.fields['cause'])).toContain('the bucket refused the manifest');
    // Not marked done, so the next pod of this build publishes again rather than skipping.
    expect((await publish(memory, clock, 'b1', [css('/styles/aaaaaaaa.css', 'a')])).outcome).toBe(
      'published',
    );
  });

  test("a file over the disk's put ceiling is skipped, listed in one line, and left out of the manifest", async () => {
    const clock = frozenClock('2026-11-03T00:00:00Z');
    const disk = memoryStorageDriver({ clock, maxPutBytes: 512 });
    const { log, lines } = recorder();
    const film = new Blob([new Uint8Array(4096)], { type: 'video/mp4' });

    const report = await publish(
      disk,
      clock,
      'b1',
      [
        css('/styles/aaaaaaaa.css', 'a{}'),
        { url: '/assets/film.12345678.mp4', contentType: 'video/mp4', body: film },
      ],
      log,
    );

    expect(report).toMatchObject({ outcome: 'published', put: 1 });
    expect(report.skipped).toEqual(['/assets/film.12345678.mp4']);
    expect(lines).toEqual([
      {
        level: 'warn',
        message: 'assets.retain_skipped',
        fields: expect.objectContaining({ urls: ['/assets/film.12345678.mp4'], disk: 'assets' }),
      },
    ]);
    const manifest = await disk.get(mkey('b1'));
    expect(new TextDecoder().decode(manifest.bytes)).not.toContain('film');
  });

  test('an object a concurrent sweep removed before the manifest landed is put back', async () => {
    const clock = frozenClock('2026-11-03T00:00:00Z');
    const memory = memoryStorageDriver({ clock });
    const kept = css('/styles/aaaaaaaa.css', 'a{}');
    await memory.put(fileKey(kept.url), text('a{}'));
    const racing = counted(memory, async (key) => {
      if (key === mkey('b2')) await memory.delete(fileKey(kept.url));
    });

    await publish(racing.disk, clock, 'b2', [kept]);

    expect(await memory.exists(fileKey(kept.url))).toBe(true);
  });
});

describe('the sweep, paged and refusing to guess', () => {
  test('one manifest that does not parse stops it: nothing is deleted on an unknown claim', async () => {
    const clock = frozenClock('2026-11-03T00:00:00Z');
    const memory = memoryStorageDriver({ clock });
    // A page of one, so every listing walks its cursor to the end.
    const paged: StorageDriver = {
      ...memory,
      list: (options) => memory.list({ ...options, limit: 1 }),
    };
    await publish(paged, clock, 'b1', [css('/islands/one-11111111.js', 'one')]);
    for (const [name, body] of [
      ['garbled', '{'],
      ['shapeless', '{"buildId":1}'],
    ] as const) {
      await memory.put(mkey(name), text(body));
    }
    clock.advance(HOUR);
    await publish(paged, clock, 'b2', [css('/islands/two-22222222.js', 'two')]);
    clock.advance(HOUR);
    const third = await publish(paged, clock, 'b3', [css('/islands/six-33333333.js', 'six')]);

    expect(third.swept).toBe(0);
    expect(await memory.exists(fileKey('/islands/one-11111111.js'))).toBe(true);
  });

  test('builds published in the same instant keep a stable order, by build id', async () => {
    const clock = frozenClock('2026-11-03T00:00:00Z');
    const disk = memoryStorageDriver({ clock });
    for (const id of ['c', 'a', 'b'])
      await publish(disk, clock, id, [css(`/islands/${id}-0000000${id}.js`, id)]);

    expect(await disk.exists(mkey('a'))).toBe(true);
    expect(await disk.exists(mkey('b'))).toBe(true);
    expect(await disk.exists(mkey('c'))).toBe(false);
  });
});

describe('one disk, many apps and environments', () => {
  test("a scope's sweep never touches another app's or environment's builds", async () => {
    const clock = frozenClock('2026-11-03T00:00:00Z');
    const disk = memoryStorageDriver({ clock });
    const scoped = (prefix: string, buildId: string, url: string) =>
      publishBuildAssets({
        disk,
        prefix,
        diskName: 'assets',
        buildId,
        builds: 1,
        assets: [css(url, url)],
        clock,
        log: recorder().log,
      });
    const production = retainedPrefix('shop', 'production');
    const staging = retainedPrefix('shop', 'staging');
    const blog = retainedPrefix('blog', 'production');

    await scoped(production, 'p1', '/islands/a-11111111.js');
    await scoped(blog, 'p1', '/islands/a-11111111.js');
    for (const id of ['s1', 's2', 's3']) {
      clock.advance(HOUR);
      await scoped(staging, id, `/islands/${id}-22222222.js`);
    }

    expect(await disk.exists(retainedFileKey(production, '/islands/a-11111111.js'))).toBe(true);
    expect(await disk.exists(retainedFileKey(blog, '/islands/a-11111111.js'))).toBe(true);
    expect(await disk.exists(manifestKey(production, 'p1'))).toBe(true);
    expect(await disk.exists(manifestKey(blog, 'p1'))).toBe(true);
    expect(await disk.exists(retainedFileKey(staging, '/islands/s1-22222222.js'))).toBe(false);
    expect(production).toBe('x-build-assets/shop/production');
  });
});

describe('publishBuildAssets deadlineMs', () => {
  // `setTimeout(…, NaN)` fires at once, so an unscreened NaN deadline abandoned every publish.
  test.each([Number.NaN, 0, 2.5])(
    '%p is refused before the disk is touched',
    async (deadlineMs) => {
      const disk = memoryStorageDriver();
      const { log } = recorder();
      const publishing = publishBuildAssets({
        disk,
        prefix: PREFIX,
        diskName: 'assets',
        buildId: 'b1',
        builds: 1,
        assets: [css('/styles/a-11111111.css', 'a{}')],
        log,
        deadlineMs,
      });
      await expect(publishing).rejects.toThrow('X_INVARIANT');
      expect(await disk.exists(mkey('b1'))).toBe(false);
    },
  );
});
