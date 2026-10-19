// The local disk keeps an object in TWO files — the bytes and a sidecar — so every claim here is
// about the pair: one put() never leaves half of itself behind, and two never leave one's bytes
// under the other's etag.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API, no recursive remove, no `mkdir` and no directory listing —
// `mkdtemp`, `rm`, `mkdir` and `readdir` have no `Bun.*` equivalent, and this suite reads the
// disk's own staging directory.
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
// why: Bun exposes no `tmpdir()`; `node:os` is the only way to ask the platform where its
// temporary directory is.
import { tmpdir } from 'node:os';
import { etagOf, type StorageDriver } from './driver';
import { localDriver } from './driver-local';
import { keyedQueue } from './driver-local-write';
import { bytesOf, textOf } from './driver-s3-fixture';
import { isStorageError } from './errors';

let root = '';
let disk: StorageDriver;

beforeEach(async () => {
  root = await mkdtemp(`${tmpdir()}/ultimate-local-write-`);
  disk = localDriver({ root, signingSecret: 'test-secret', maxPutBytes: 16 * 1024 * 1024 });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A body big enough that writing it takes longer than writing a sidecar. */
const big = (fill: string): Uint8Array => bytesOf(fill.repeat(4 * 1024 * 1024));

describe('two concurrent puts of one key', () => {
  test('leave one writer’s bytes under that same writer’s etag and type', async () => {
    // Bytes then sidecar, in place and unserialised: the small write finished both files while
    // the large one was still on its first, so the object ended as the large bytes under the
    // large sidecar — or, interleaved the other way, one's bytes under the other's etag.
    for (let round = 0; round < 12; round += 1) {
      const key = `org/o1/race-${round}.bin`;
      const large = big('a');
      const small = bytesOf(`small-${round}`);
      await Promise.all([
        disk.put(key, large, { contentType: 'text/large' }),
        disk.put(key, small, { contentType: 'text/small' }),
        disk.put(key, large, { contentType: 'text/large' }),
        disk.put(key, small, { contentType: 'text/small' }),
      ]);
      const read = await disk.get(key);
      expect(read.object.etag).toBe(etagOf(read.bytes));
      expect(read.object.contentType).toBe(
        read.bytes.byteLength === small.byteLength ? 'text/small' : 'text/large',
      );
      expect([large.byteLength, small.byteLength]).toContain(read.bytes.byteLength);
    }
  });

  test('a read racing an overwrite sees a whole object, old or new', async () => {
    const key = 'org/o1/overwritten.bin';
    const before = big('b');
    const after = bytesOf('after');
    await disk.put(key, before, { contentType: 'text/before' });
    const reads: Promise<{ readonly size: number; readonly etagOk: boolean }>[] = [];
    const writes: Promise<unknown>[] = [];
    for (let turn = 0; turn < 8; turn += 1) {
      writes.push(disk.put(key, turn % 2 === 0 ? after : before));
      reads.push(
        disk.get(key).then((read) => ({
          size: read.bytes.byteLength,
          etagOk: read.object.etag === etagOf(read.bytes),
        })),
      );
    }
    await Promise.all(writes);
    for (const read of await Promise.all(reads)) {
      expect([before.byteLength, after.byteLength]).toContain(read.size);
      expect(read.etagOk).toBe(true);
    }
  });
});

describe('stat(), list() and copy() queue behind a key’s writer', () => {
  // Unqueued, a measurement interleaved with a commit: the size of one generation read before the
  // commit, the sidecar of the next read after it. Issued while a put() is committing, each of
  // these must answer the object that put() leaves — which only waiting its turn can do.
  test('a measurement issued mid-commit answers the committed object, whole', async () => {
    const key = 'org/o1/measured.bin';
    const large = big('d');
    await disk.put(key, bytesOf('small'), { contentType: 'text/small' });

    const write = disk.put(key, large, { contentType: 'text/large' });
    // One macrotask: the put has hashed its body and its commit holds the key's queue.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const [stat, page, copied] = await Promise.all([
      disk.stat(key),
      disk.list({ prefix: key }),
      disk.copy(key, 'org/o1/measured-copy.bin'),
    ]);
    await write;

    const whole = [large.byteLength, etagOf(large), 'text/large'];
    expect([stat?.size, stat?.etag, stat?.contentType]).toEqual(whole);
    const listed = page.rows[0];
    expect([listed?.size, listed?.etag, listed?.contentType]).toEqual(whole);
    expect([copied.size, copied.etag, copied.contentType]).toEqual(whole);
  });
});

describe('what a put() stages never becomes an object', () => {
  test('nothing but the key is listed, and the staging directory is empty afterwards', async () => {
    await disk.put('org/o1/a.txt', bytesOf('one'));
    await disk.copy('org/o1/a.txt', 'org/o1/b.txt');
    expect((await disk.list()).rows.map((object) => object.key)).toEqual([
      'org/o1/a.txt',
      'org/o1/b.txt',
    ]);
    expect(await readdir(`${root}/.meta/.tmp`)).toEqual([]);
  });

  test('a refused put leaves no staged file behind', async () => {
    await disk.put('a', bytesOf('file'));
    await disk.put('a/b', bytesOf('x')).catch(() => undefined);
    expect(await readdir(`${root}/.meta/.tmp`).catch(() => [])).toEqual([]);
    expect(textOf((await disk.get('a')).bytes)).toBe('file');
  });

  test('a copy whose source vanishes while it waits is "not found", with nothing staged', async () => {
    // The copy is queued behind the destination's other writer, so its source can be deleted in
    // between: it must answer "not found" and leave no staged half-copy behind.
    //
    // The destination's queue is HELD by the test, never by how long a write takes: a 4 MB body
    // as the "slow" writer finished before the delete on a loaded runner, and the precondition
    // below failed (CI run 38053268317, gate unit-3). The disk is given a queue the test holds.
    const queue = keyedQueue();
    const held = localDriver({ root, signingSecret: 'test-secret', queue });
    await held.put('org/o1/src.txt', bytesOf('source'));
    const gate = Promise.withResolvers<void>();
    // `dst` sorts before `src`, so the copy's first turn is this held one and it takes the
    // source's only after: the delete below cannot be queued behind the copy.
    const holder = queue('org/o1/dst.txt', () => gate.promise);
    const other = held.put('org/o1/dst.txt', bytesOf('the other writer'));
    let copyWaiting = true;
    const copy = held
      .copy('org/o1/src.txt', 'org/o1/dst.txt')
      .catch((error: unknown) => error)
      .finally(() => {
        copyWaiting = false;
      });
    let destinationBusy = true;
    const settled = other.then(() => {
      destinationBusy = false;
    });
    await held.delete('org/o1/src.txt');
    // The claim this test makes: the source went while the destination was still held, and the
    // copy was still waiting for it — not refused early, not already done.
    expect(destinationBusy).toBe(true);
    expect(await held.exists('org/o1/src.txt')).toBe(false);
    expect(copyWaiting).toBe(true);
    gate.resolve();
    await holder;
    await settled;
    const refused = await copy;
    expect(isStorageError(refused) ? refused.code : refused).toBe('X_STORAGE_NOT_FOUND');
    expect(await readdir(`${root}/.meta/.tmp`)).toEqual([]);
    expect(textOf((await held.get('org/o1/dst.txt')).bytes)).toBe('the other writer');
  });

  test('a copy whose source is overwritten while it waits copies one generation, whole', async () => {
    // Measured in the source's turn and read in the destination's, the copy committed the NEW
    // bytes under the OLD etag and type — no marker flags that pair, so `get()` trusted it.
    const queue = keyedQueue();
    const held = localDriver({ root, signingSecret: 'test-secret', queue });
    await held.put('org/o1/src.txt', bytesOf('old'), { contentType: 'text/old' });
    const gate = Promise.withResolvers<void>();
    const holder = queue('org/o1/dst.txt', () => gate.promise);
    const copy = held.copy('org/o1/src.txt', 'org/o1/dst.txt');
    await held.put('org/o1/src.txt', bytesOf('new, longer'), { contentType: 'text/new' });
    gate.resolve();
    await holder;
    const copied = await copy;
    const read = await held.get('org/o1/dst.txt');
    expect([textOf(read.bytes), read.object.contentType, read.object.etag]).toEqual([
      'new, longer',
      'text/new',
      etagOf(read.bytes),
    ]);
    expect([copied.size, copied.etag]).toEqual([read.bytes.byteLength, read.object.etag]);
  });

  test('two copies crossing the same two keys both finish', async () => {
    // Each copy holds both keys' turns; taken in key order, `a → b` and `b → a` cannot each hold
    // the turn the other waits on.
    await disk.put('org/o1/a.txt', bytesOf('a'));
    await disk.put('org/o1/b.txt', bytesOf('b'));
    const both = await Promise.all([
      disk.copy('org/o1/a.txt', 'org/o1/b.txt'),
      disk.copy('org/o1/b.txt', 'org/o1/a.txt'),
      disk.copy('org/o1/a.txt', 'org/o1/a.txt'),
    ]);
    expect(both.map((object) => object.key)).toEqual([
      'org/o1/b.txt',
      'org/o1/a.txt',
      'org/o1/a.txt',
    ]);
  });

  test('a write that fails after staging its bytes removes them', async () => {
    // The staged name is a UUID; pinning it lets a directory stand where the SECOND staged file
    // must go, which is the cheapest failure between "bytes staged" and "bytes renamed".
    const real = crypto.randomUUID;
    crypto.randomUUID = () => '00000000-0000-4000-8000-000000000000';
    try {
      await mkdir(`${root}/.meta/.tmp/00000000-0000-4000-8000-000000000000.sidecar`, {
        recursive: true,
      });
      const refused = await disk.put('org/o1/a.txt', bytesOf('one')).catch(() => 'refused');
      expect(refused).toBe('refused');
    } finally {
      crypto.randomUUID = real;
    }
    expect(await readdir(`${root}/.meta/.tmp`)).toEqual([
      '00000000-0000-4000-8000-000000000000.sidecar',
    ]);
    expect(await disk.exists('org/o1/a.txt')).toBe(false);
  });
});
