// `memoryDriver()` beside `localDriver()`: the disk a TEST holds answers every question the dev
// disk answers, the same way — so a suite that swaps a temp directory for a heap map is asserting
// the same contract, and a hand-written `StorageDriver` in a test file is never needed again.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API and no recursive remove.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no `tmpdir()`.
import { tmpdir } from 'node:os';
import { frozenClock, isUltimateError } from '@ultimat3/core';
import type { StorageDriver } from './driver';
import { sha256Base64 } from './driver';
import { localDriver } from './driver-local';
import { memoryDriver } from './driver-memory';
import { defineStorage, disk, resetStorage } from './storage';

const clock = frozenClock('2026-10-01T09:00:00.000Z');
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (read: { readonly bytes: Uint8Array }): string => new TextDecoder().decode(read.bytes);
const codeOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (thrown) {
    return isUltimateError(thrown) ? thrown.code : `uncoded: ${String(thrown)}`;
  }
  return 'resolved';
};

let root = '';
let pair: readonly (readonly [string, StorageDriver])[];

beforeEach(async () => {
  root = await mkdtemp(`${tmpdir()}/ultimate-memory-parity-`);
  pair = [
    ['local', localDriver({ root, signingSecret: 'test-secret', clock })],
    ['memory', memoryDriver({ signingSecret: 'test-secret', clock })],
  ];
});

afterEach(async () => {
  resetStorage();
  await rm(root, { recursive: true, force: true });
});

describe('the memory disk answers as the local disk does', () => {
  test('put, get, exists and delete round-trip an object with what put was told', async () => {
    for (const [name, driver] of pair) {
      const stored = await driver.put('org/o1/a.json', bytes('{"a":1}'), {
        contentType: 'application/json',
        cacheControl: 'no-store',
        metadata: { owner: 'ada' },
      });
      expect([name, stored.size, stored.contentType]).toEqual([name, 7, 'application/json']);
      const read = await driver.get('org/o1/a.json');
      expect([name, text(read)]).toEqual([name, '{"a":1}']);
      expect(read.object).toMatchObject({
        key: 'org/o1/a.json',
        contentType: 'application/json',
        cacheControl: 'no-store',
        metadata: { owner: 'ada' },
        etag: stored.etag,
      });
      expect([name, await driver.exists('org/o1/a.json')]).toEqual([name, true]);
      await driver.delete('org/o1/a.json');
      // Deleting an absent key is not an error, on either.
      await driver.delete('org/o1/a.json');
      expect([name, await driver.exists('org/o1/a.json')]).toEqual([name, false]);
      expect([name, await codeOf(() => driver.get('org/o1/a.json'))]).toEqual([
        name,
        'X_STORAGE_NOT_FOUND',
      ]);
    }
  });

  test('a key that escapes, a wrong checksum and an oversized body are refused by code', async () => {
    const small = memoryDriver({ maxPutBytes: 4 });
    expect(await codeOf(() => small.put('big.bin', bytes('12345')))).toBe('X_STORAGE_TOO_LARGE');
    for (const [name, driver] of pair) {
      expect([name, await codeOf(() => driver.put('../escape.txt', bytes('x')))]).toEqual([
        name,
        'X_STORAGE_PATH_UNSAFE',
      ]);
      expect([
        name,
        await codeOf(() => driver.put('a.txt', bytes('x'), { checksum: sha256Base64(bytes('y')) })),
      ]).toEqual([name, 'X_STORAGE_CHECKSUM_MISMATCH']);
      expect([
        name,
        await codeOf(() =>
          driver.put('a.txt', bytes('x'), { serverSideEncryption: { algorithm: 'AES256' } }),
        ),
      ]).toEqual([name, 'X_NOT_IMPLEMENTED']);
    }
  });

  test('a listing is ordered, prefixed and paged by the last key of the page before', async () => {
    for (const [name, driver] of pair) {
      for (const key of ['b/2.txt', 'a/1.txt', 'b/1.txt', 'b/3.txt']) {
        await driver.put(key, bytes(key));
      }
      const first = await driver.list({ prefix: 'b/', limit: 2 });
      expect([name, first.objects.map((object) => object.key), first.truncated]).toEqual([
        name,
        ['b/1.txt', 'b/2.txt'],
        true,
      ]);
      const next = await driver.list({ prefix: 'b/', limit: 2, cursor: first.cursor });
      expect([name, next.objects.map((object) => object.key), next.truncated]).toEqual([
        name,
        ['b/3.txt'],
        false,
      ]);
      expect([name, await codeOf(() => driver.list({ limit: 0 }))]).toEqual([name, 'X_INVARIANT']);
    }
  });

  test('copy leaves the source, and stream yields the stored bytes', async () => {
    for (const [name, driver] of pair) {
      await driver.put('from.txt', bytes('payload'), { contentType: 'text/plain' });
      const copied = await driver.copy('from.txt', 'to.txt');
      expect([name, copied.key, copied.contentType]).toEqual([name, 'to.txt', 'text/plain']);
      expect([name, await driver.exists('from.txt')]).toEqual([name, true]);
      const streamed = new Uint8Array(
        await new Response(await driver.stream('to.txt')).arrayBuffer(),
      );
      expect([name, new TextDecoder().decode(streamed)]).toEqual([name, 'payload']);
      expect([name, await codeOf(() => driver.copy('absent.txt', 'x.txt'))]).toEqual([
        name,
        'X_STORAGE_NOT_FOUND',
      ]);
    }
  });

  test('a URL the disk signed is one it verifies, under the name it was registered as', async () => {
    const memory = memoryDriver({ signingSecret: 'test-secret', clock });
    defineStorage({ disks: { sessions: memory } });
    const url = await disk('sessions').signedUrl('org/o1/a.txt', { method: 'PUT', maxBytes: 10 });
    expect(url).toContain('/sessions/');
    const verified = await memory.verifySigned?.({ url });
    expect(verified?.ok).toBe(true);
    const forged = await memory.verifySigned?.({ url: url.replace('a.txt', 'b.txt') });
    expect(forged?.ok).toBe(false);
  });

  test('what was written is readable back as stored bytes, for an assertion about the bucket', async () => {
    const memory = memoryDriver();
    await memory.put('scrape-session/a.json', bytes('{"sealed":"x1.abc"}'));
    // A copy: mutating what a test read must not rewrite the object.
    const stored = memory.objects().get('scrape-session/a.json');
    stored?.fill(0);
    expect(text(await memory.get('scrape-session/a.json'))).toBe('{"sealed":"x1.abc"}');
    expect([...memory.objects().keys()]).toEqual(['scrape-session/a.json']);
  });

  test('outside development the published signing key is refused, as on the local disk', () => {
    const production = { NODE_ENV: 'production' };
    const refused = (() => {
      try {
        memoryDriver({ env: production });
      } catch (thrown) {
        return isUltimateError(thrown) ? thrown.code : 'uncoded';
      }
      return 'constructed';
    })();
    expect(refused).toBe('X_ENV_MISSING');
  });
});
