// A resolved disk's multipart session reports each change it makes — opened, a part stored,
// assembled, dropped — as `storage.multipart` with its `op`, so a large upload is as visible on
// the bus as a `put`. Signing a part URL and listing parts change nothing, and report nothing.

import { afterEach, describe, expect, test } from 'bun:test';
import type { StorageMultipartEvent } from '@ultimat3/core';
import { resetInstrumentation, subscribe } from '@ultimat3/core';
import { memoryStorageDriver } from './driver-memory';
import { defineStorage, resetStorage } from './storage';

const bytes = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);

function listen(): StorageMultipartEvent[] {
  const events: StorageMultipartEvent[] = [];
  subscribe('storage.multipart', (event) => events.push(event.payload));
  return events;
}

afterEach(() => {
  resetInstrumentation();
  resetStorage();
});

const uploadsDisk = () =>
  defineStorage({ disks: { uploads: memoryStorageDriver() } }).disk('uploads');

describe('unit · storage · multipart instrumentation', () => {
  test('create, part, complete and abort each report once, on the disk and key they ran on', async () => {
    const disk = uploadsDisk();
    const multipart = disk.multipart;
    if (multipart === undefined) return expect.unreachable('the memory disk takes multipart');
    const seen = listen();
    const kept = await multipart.create('org/a/big.csv', { contentType: 'text/csv' });
    const part = await multipart.receivePart?.('org/a/big.csv', kept, 1, bytes('hello'));
    await multipart.listParts('org/a/big.csv', kept);
    await multipart.complete('org/a/big.csv', kept, part === undefined ? [] : [part]);
    const dropped = await multipart.create('org/a/gone.csv', { contentType: 'text/csv' });
    await multipart.abort('org/a/gone.csv', dropped);
    expect(seen.map(({ op, disk: name, key }) => [op, name, key])).toEqual([
      ['create', 'uploads', 'org/a/big.csv'],
      ['part', 'uploads', 'org/a/big.csv'],
      ['complete', 'uploads', 'org/a/big.csv'],
      ['create', 'uploads', 'org/a/gone.csv'],
      ['abort', 'uploads', 'org/a/gone.csv'],
    ]);
    expect(seen[1]?.bytes).toBe(5);
    expect(seen[2]?.bytes).toBe(5);
    for (const event of seen) expect(event.error).toBeUndefined();
  });

  test('a refused call is still an event, carrying the error the caller receives', async () => {
    const multipart = uploadsDisk().multipart;
    if (multipart === undefined) return expect.unreachable('the memory disk takes multipart');
    const seen = listen();
    const thrown = await multipart
      .complete('org/a/none.csv', 'no-such-upload', [])
      .catch((error: unknown) => error);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.error).toBe(thrown);
  });

  test('the capability is the same object on every read, and a raw driver reports nothing', async () => {
    const raw = memoryStorageDriver();
    const disk = defineStorage({ disks: { uploads: raw } }).disk('uploads');
    expect(disk.multipart).toBe(disk.multipart);
    const seen = listen();
    await raw.multipart?.create('org/a/raw.csv', { contentType: 'text/csv' });
    expect(seen).toEqual([]);
  });
});
