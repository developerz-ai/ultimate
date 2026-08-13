import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { frozenClock } from '@ultimat3/core';
import type { StorageDriver } from './driver';
import { localDriver } from './driver-local';
import { isStorageError } from './errors';

let root = '';
let driver: StorageDriver;

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);
const textOf = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

beforeEach(async () => {
  root = await mkdtemp(`${tmpdir()}/ultimate-storage-`);
  driver = localDriver({
    root,
    signingSecret: 'test-secret',
    clock: frozenClock('2026-07-26T12:00:00.000Z'),
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('localDriver', () => {
  test('round-trips put -> exists -> get -> list -> delete with the content type', async () => {
    const key = 'org/org-1/avatars/a.png';
    const put = await driver.put(key, bytesOf('pretend-png'), { contentType: 'image/png' });
    expect(put.key).toBe(key);
    expect(put.size).toBe(11);
    expect(put.contentType).toBe('image/png');
    expect(put.etag.length).toBe(32);

    expect(await driver.exists(key)).toBe(true);

    const read = await driver.get(key);
    expect(textOf(read.bytes)).toBe('pretend-png');
    // The sidecar exists precisely so this survives a process restart.
    expect(read.object.contentType).toBe('image/png');
    expect(read.object.etag).toBe(put.etag);
    expect(read.object.size).toBe(11);

    const page = await driver.list({ prefix: 'org/org-1/' });
    expect(page.objects.map((object) => object.key)).toEqual([key]);
    expect(page.truncated).toBe(false);
    // The `.meta` sidecar tree must never appear as an object.
    expect(page.objects.every((object) => !object.key.startsWith('.meta/'))).toBe(true);

    await driver.delete(key);
    expect(await driver.exists(key)).toBe(false);
    expect((await driver.list({ prefix: 'org/org-1/' })).objects).toEqual([]);
  });

  test('get and list round-trip cacheControl and metadata written by put()', async () => {
    const key = 'org/org-1/docs/report.pdf';
    await driver.put(key, bytesOf('pdf-bytes'), {
      contentType: 'application/pdf',
      cacheControl: 'public, max-age=3600',
      metadata: { uploadedBy: 'user-1' },
    });

    const read = await driver.get(key);
    expect(read.object.cacheControl).toBe('public, max-age=3600');
    expect(read.object.metadata).toEqual({ uploadedBy: 'user-1' });

    const [listed] = (await driver.list({ prefix: 'org/org-1/' })).objects;
    expect(listed?.cacheControl).toBe('public, max-age=3600');
    expect(listed?.metadata).toEqual({ uploadedBy: 'user-1' });
  });

  test('get on a missing key is X_STORAGE_NOT_FOUND', async () => {
    let caught: unknown;
    try {
      await driver.get('org/org-1/missing.png');
    } catch (error) {
      caught = error;
    }
    expect(isStorageError(caught)).toBe(true);
    expect(isStorageError(caught) ? caught.code : '').toBe('X_STORAGE_NOT_FOUND');
  });

  test('delete is idempotent', async () => {
    await driver.delete('org/org-1/never-existed.png');
    expect(await driver.exists('org/org-1/never-existed.png')).toBe(false);
  });

  test('an unsafe key never reaches the file system', async () => {
    const escapee = `escaped-${crypto.randomUUID()}.png`;
    let caught: unknown;
    try {
      await driver.put(`../${escapee}`, bytesOf('x'));
    } catch (error) {
      caught = error;
    }
    expect(isStorageError(caught) ? caught.code : '').toBe('X_STORAGE_PATH_UNSAFE');
    expect(await Bun.file(`${root}/../${escapee}`).exists()).toBe(false);
  });

  test('list paginates by cursor in lexicographic order', async () => {
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      await driver.put(`org/org-1/${name}`, bytesOf(name), { contentType: 'text/plain' });
    }
    const first = await driver.list({ prefix: 'org/org-1/', limit: 2 });
    expect(first.objects.map((object) => object.key)).toEqual([
      'org/org-1/a.txt',
      'org/org-1/b.txt',
    ]);
    expect(first.truncated).toBe(true);

    const second = await driver.list({ prefix: 'org/org-1/', limit: 2, cursor: first.cursor });
    expect(second.objects.map((object) => object.key)).toEqual(['org/org-1/c.txt']);
    expect(second.truncated).toBe(false);
  });

  test('signedUrl is verifiable and carries the constraints', async () => {
    const url = await driver.signedUrl('org/org-1/a.png', {
      method: 'PUT',
      maxBytes: 2048,
      contentType: 'image/png',
    });
    expect(url.startsWith('/_storage/local/org/org-1/a.png?')).toBe(true);
    expect(url).toContain('x-max=2048');
  });

  test('stream yields the stored bytes', async () => {
    await driver.put('org/org-1/s.txt', bytesOf('streamed'), { contentType: 'text/plain' });
    const stream = await driver.stream('org/org-1/s.txt');
    expect(await new Response(stream).text()).toBe('streamed');
  });
});
