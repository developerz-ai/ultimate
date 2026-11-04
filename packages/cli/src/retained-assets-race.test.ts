// The retention window when pods race: a sweep on one pod must never delete what another pod is
// publishing or has just published, a build already published heals and re-dates its manifest
// when a pod of it boots again (a rollback is the live build), a stalled disk cannot hold a pod
// out of readiness, and a file swept between `stat` and its first byte is a miss, not a broken 200.

import { describe, expect, test } from 'bun:test';
import type { FrozenClock } from '@ultimat3/core';
import { frozenClock } from '@ultimat3/core';
import { defineHttpConfig, requestContext, UltimateRequest } from '@ultimat3/http';
import type { ListOptions, StorageDriver } from '@ultimat3/storage';
import { memoryStorageDriver, StorageError } from '@ultimat3/storage';
import type { BuildAsset, RetainLog } from './retained-assets';
import { publishBuildAssets } from './retained-assets';
import { manifestKey, retainedFileKey, retainedPrefix } from './retained-assets-layout';
import { retainedAssets } from './retained-assets-read';

const PREFIX = retainedPrefix('app', 'production');
const fileKey = (url: string): string => retainedFileKey(PREFIX, url);
const mkey = (buildId: string): string => manifestKey(PREFIX, buildId);
const HOUR = 3_600_000;
const quiet: RetainLog = { warn: () => undefined, error: () => undefined };
const js = (url: string): BuildAsset => ({
  url,
  contentType: 'text/javascript',
  body: new TextEncoder().encode(url),
});

const publish = (
  disk: StorageDriver,
  clock: FrozenClock,
  buildId: string,
  assets: readonly BuildAsset[],
  builds = 1,
) =>
  publishBuildAssets({
    disk,
    prefix: PREFIX,
    diskName: 'assets',
    buildId,
    builds,
    assets,
    clock,
    log: quiet,
  });

/** Runs `between` once, after the sweep has read the manifests and before it lists the objects. */
const midSweep = (disk: StorageDriver, between: () => Promise<void>): StorageDriver => {
  let fired = false;
  return {
    ...disk,
    list: async (options?: ListOptions) => {
      if (!fired && options?.prefix === `${PREFIX}/files/`) {
        fired = true;
        await between();
      }
      return disk.list(options);
    },
  };
};

describe('a sweep racing another pod', () => {
  test('a file a pod put moments ago, its manifest not yet written, is not swept', async () => {
    const clock = frozenClock('2026-11-03T00:00:00Z');
    const memory = memoryStorageDriver({ clock });
    await publish(memory, clock, 'a1', [js('/islands/a-11111111.js')]);
    clock.advance(HOUR);
    const inFlight = fileKey('/islands/b-22222222.js');
    const racing = midSweep(memory, async () => {
      await memory.put(inFlight, new TextEncoder().encode('b'));
    });

    await publish(racing, clock, 'a2', [js('/islands/a-33333333.js')]);

    expect(await memory.exists(inFlight)).toBe(true);
    expect(await memory.exists(fileKey('/islands/a-11111111.js'))).toBe(false);
  });

  test('a file a manifest written after the sweep read the others names is not swept, however old', async () => {
    const clock = frozenClock('2026-11-03T00:00:00Z');
    const memory = memoryStorageDriver({ clock });
    const reused = js('/islands/a-11111111.js');
    await publish(memory, clock, 'a1', [reused]);
    clock.advance(HOUR);
    // Build b reuses a1's file, finds it present, and completes while a2's sweep is mid-flight.
    const racing = midSweep(memory, async () => {
      await publish(memory, clock, 'b', [reused], 3);
    });

    await publish(racing, clock, 'a2', [js('/islands/a-33333333.js')]);

    expect(await memory.exists(mkey('b'))).toBe(true);
    expect(await memory.exists(fileKey(reused.url))).toBe(true);
  });
});

describe('a sweep racing a rollback', () => {
  test('a dropped build re-dated while the sweep ran keeps its manifest and its files', async () => {
    const clock = frozenClock('2026-11-03T00:00:00Z');
    const memory = memoryStorageDriver({ clock });
    const old = js('/islands/o-11111111.js');
    await publish(memory, clock, 'old', [old]);
    clock.advance(HOUR);
    // Pods of `old` boot again mid-sweep: the rollback is now the newest build.
    const racing = midSweep(memory, async () => {
      clock.advance(1);
      await publish(memory, clock, 'old', [old]);
    });

    await publish(racing, clock, 'new', [js('/islands/n-22222222.js')]);

    expect(await memory.exists(mkey('old'))).toBe(true);
    expect(await memory.exists(fileKey(old.url))).toBe(true);
  });
});

describe('a manifest that vanishes between the listing and its read', () => {
  const vanishing = (memory: StorageDriver, code: string): StorageDriver => ({
    ...memory,
    get: async (key, options) => {
      if (key === mkey('gone')) {
        throw new StorageError({
          code: code as 'X_STORAGE_NOT_FOUND',
          cause: code,
          fix: 'x doctor --json',
        });
      }
      return memory.get(key, options);
    },
  });

  test('swept by another pod: it is no longer a manifest, and the publish completes', async () => {
    const clock = frozenClock('2026-11-03T00:00:00Z');
    const memory = memoryStorageDriver({ clock });
    await publish(memory, clock, 'gone', [js('/islands/g-11111111.js')]);
    clock.advance(HOUR);

    const report = await publish(vanishing(memory, 'X_STORAGE_NOT_FOUND'), clock, 'b', []);

    expect(report.outcome).toBe('published');
  });

  test('any other refusal fails the publish rather than guessing what the manifest named', async () => {
    const clock = frozenClock('2026-11-03T00:00:00Z');
    const memory = memoryStorageDriver({ clock });
    await publish(memory, clock, 'gone', [js('/islands/g-11111111.js')]);
    clock.advance(HOUR);

    const report = await publish(vanishing(memory, 'X_STORAGE_READ_FAILED'), clock, 'b', []);

    expect(report.outcome).toBe('failed');
    expect(await memory.exists(fileKey('/islands/g-11111111.js'))).toBe(true);
  });
});

describe('a build already published', () => {
  test('puts back a file a bad sweep removed, and answers present', async () => {
    const clock = frozenClock('2026-11-03T00:00:00Z');
    const memory = memoryStorageDriver({ clock });
    const asset = js('/islands/a-11111111.js');
    await publish(memory, clock, 'a1', [asset]);
    await memory.delete(fileKey(asset.url));

    const again = await publish(memory, clock, 'a1', [asset]);

    expect(again).toMatchObject({ outcome: 'present', put: 1 });
    expect(await memory.exists(fileKey(asset.url))).toBe(true);
  });

  test('re-dates its manifest, so a rolled-back build is the newest and is not swept first', async () => {
    const clock = frozenClock('2026-11-03T00:00:00Z');
    const memory = memoryStorageDriver({ clock });
    await publish(memory, clock, 'old', [js('/islands/o-11111111.js')], 2);
    clock.advance(HOUR);
    await publish(memory, clock, 'new', [js('/islands/n-22222222.js')], 2);
    clock.advance(HOUR);
    // The rollback: pods of `old` boot again and are what serves.
    expect((await publish(memory, clock, 'old', [js('/islands/o-11111111.js')], 2)).outcome).toBe(
      'present',
    );
    clock.advance(HOUR);
    await publish(memory, clock, 'next', [js('/islands/x-33333333.js')], 2);

    expect(await memory.exists(mkey('old'))).toBe(true);
    expect(await memory.exists(mkey('new'))).toBe(false);
  });
});

describe('a disk that stalls', () => {
  test('the publish gives up at its deadline: failed, one coded line, and the pod serves', async () => {
    const memory = memoryStorageDriver();
    const stalled: StorageDriver = {
      ...memory,
      exists: () => new Promise<boolean>(() => undefined),
    };
    const lines: Readonly<Record<string, unknown>>[] = [];
    const report = await publishBuildAssets({
      disk: stalled,
      prefix: PREFIX,
      diskName: 'assets',
      buildId: 'b1',
      builds: 1,
      assets: [js('/islands/a-11111111.js')],
      deadlineMs: 1,
      log: { warn: () => undefined, error: (_message, fields) => lines.push(fields) },
    });

    expect(report.outcome).toBe('failed');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ code: 'X_ASSET_RETAIN_FAILED' });
    expect(String(lines[0]?.['cause'])).toContain('did not finish within 1ms');
  });
});

describe('a file swept between stat and its bytes', () => {
  const refused = (): StorageError =>
    new StorageError({ code: 'X_STORAGE_NOT_FOUND', cause: 'swept', fix: 'x doctor --json' });
  const url = '/styles/aaaaaaaa.css';
  const request = (): UltimateRequest => {
    const href = new URL(`http://app.test${url}`);
    const ctx = requestContext({
      url: href,
      method: 'GET',
      role: 'web',
      config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
    });
    return new UltimateRequest(new Request(href), ctx);
  };
  const published = async (): Promise<StorageDriver> => {
    const clock = frozenClock('2026-11-03T00:00:00Z');
    const memory = memoryStorageDriver({ clock });
    await publish(memory, clock, 'b1', [js(url)]);
    return memory;
  };

  test('a stream that fails before its first byte is a miss, not a 200 that breaks', async () => {
    const memory = await published();
    const reader = retainedAssets({
      prefix: PREFIX,
      disk: {
        ...memory,
        stream: async () =>
          new ReadableStream<Uint8Array>({ pull: (controller) => controller.error(refused()) }),
      },
    });

    expect(await reader.read(request())).toBeUndefined();
  });

  test('every chunk after the first still arrives', async () => {
    const memory = await published();
    const chunks = ['a{', 'color:red', '}'].map((part) => new TextEncoder().encode(part));
    const reader = retainedAssets({
      prefix: PREFIX,
      disk: {
        ...memory,
        stream: async () =>
          new ReadableStream<Uint8Array>({
            start: (controller) => {
              for (const chunk of chunks) controller.enqueue(chunk);
              controller.close();
            },
          }),
      },
    });

    expect(await (await reader.read(request()))?.text()).toBe('a{color:red}');
  });

  test('a reader that walks away cancels the disk stream under it', async () => {
    const memory = await published();
    let cancelled = false;
    const reader = retainedAssets({
      prefix: PREFIX,
      disk: {
        ...memory,
        stream: async () =>
          new ReadableStream<Uint8Array>({
            start: (controller) => controller.enqueue(new Uint8Array([1])),
            cancel: () => {
              cancelled = true;
            },
          }),
      },
    });

    const answer = await reader.read(request());
    await answer?.body?.cancel();

    expect(cancelled).toBe(true);
  });

  test('a stream refused outright is a miss too', async () => {
    const memory = await published();
    const reader = retainedAssets({
      prefix: PREFIX,
      disk: { ...memory, stream: () => Promise.reject(refused()) },
    });

    expect(await reader.read(request())).toBeUndefined();
  });
});
