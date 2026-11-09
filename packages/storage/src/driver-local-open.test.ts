// The local pinned read across overwrites that land after the check and before the first pull. ext4
// hands a freed inode straight back, so two puts can leave a NEW revision at the OLD inode number:
// identity by inode alone served v3's bytes under v1's etag.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API and no recursive remove; the local disk needs a real root.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no `tmpdir()`; `node:os` is the only way to ask the platform for it.
import { tmpdir } from 'node:os';
import type { StorageDriver } from './driver';
import { localDriver } from './driver-local';

const KEY = 'org/o1/v.txt';
const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

let root = '';
let disk: StorageDriver;

beforeEach(async () => {
  root = await mkdtemp(`${tmpdir()}/ultimate-local-open-`);
  disk = localDriver({ root, signingSecret: 's' });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('a pinned local read', () => {
  test('two overwrites before the first pull are refused, never served under the old etag', async () => {
    for (let round = 0; round < 10; round += 1) {
      await disk.put(KEY, bytesOf(`v1 of round ${round}`));
      const v1 = await disk.stat(KEY);
      const body = await disk.stream(KEY, { etag: v1?.etag ?? '' });
      await disk.put(KEY, bytesOf(`v2 of round ${round}, longer`));
      await disk.put(KEY, bytesOf(`v3 of round ${round}`));
      const read = await new Response(body).text().catch((error: unknown) => error);
      expect(read).toBeUltimateError('X_STORAGE_OBJECT_CHANGED');
    }
  });

  test('with no write in between, the pinned bytes are served', async () => {
    await disk.put(KEY, bytesOf('only version'));
    const object = await disk.stat(KEY);
    const body = await disk.stream(KEY, { etag: object?.etag ?? '' });
    expect(await new Response(body).text()).toBe('only version');
  });
});
