// The s3 disk over `FakeS3Client`, held in `unit` to the port claims `storageDriverConformance`
// (`@ultimat3/testing`) runs over memory and local there and over s3 only in `live`: the fake is a
// fixture of this package, unreachable from testing, and a unit run must not need a server to
// catch an s3 regression. Slim on purpose — one test per claim the suite holds.

import { beforeEach, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import type { StorageDriver } from './driver';
import { s3Driver } from './driver-s3';
import { bytesOf, catchError, FAKE_ENV, FakeS3Client, textOf } from './driver-s3-fixture';

const KEY = 'org/org-1/a.bin';
const MAX_PUT = 8;

const refusal = async (call: () => Promise<unknown>) => {
  const caught = await catchError(call);
  return isUltimateError(caught)
    ? { code: caught.code, cause: caught.cause, fix: caught.fix }
    : { code: `not-a-coded-error: ${String(caught)}`, cause: '', fix: '' };
};
const codeOf = async (call: () => Promise<unknown>): Promise<string> => (await refusal(call)).code;

const streamOf = (...chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
const drain = (stream: ReadableStream<Uint8Array>): Promise<string> => new Response(stream).text();

let fake: FakeS3Client;
let s3: StorageDriver;

beforeEach(() => {
  fake = new FakeS3Client();
  s3 = s3Driver({
    bucket: 'b',
    client: fake,
    fetch: fake.fetch,
    env: FAKE_ENV,
    maxPutBytes: MAX_PUT,
  });
});

describe('reads', () => {
  test('an absent key, and the half of a nested pair that is not there, is absent', async () => {
    await s3.put('p', bytesOf('file'));
    await s3.put('q/r', bytesOf('nested'));
    for (const absent of ['never', 'p/x', 'q']) {
      expect([await s3.stat(absent), await s3.exists(absent)]).toEqual([undefined, false]);
      expect(await codeOf(() => s3.get(absent))).toBe('X_STORAGE_NOT_FOUND');
      expect(await codeOf(() => s3.streamRange(absent, [0, 1]))).toBe('X_STORAGE_NOT_FOUND');
    }
    expect(await codeOf(() => s3.stat('../escape'))).toBe('X_STORAGE_PATH_UNSAFE');
  });

  test('stat reports the size and type put() was told', async () => {
    await s3.put('a.png', bytesOf('12345'), { contentType: 'image/png' });
    const stat = await s3.stat('a.png');
    expect([stat?.key, stat?.size, stat?.contentType]).toEqual(['a.png', 5, 'image/png']);
  });

  test('a read pinned to an overwritten etag is X_STORAGE_OBJECT_CHANGED', async () => {
    await s3.put('v', bytesOf('first'));
    const before = { etag: (await s3.stat('v'))?.etag ?? '' };
    await s3.put('v', bytesOf('second!'));
    expect(await codeOf(() => s3.stream('v', before))).toBe('X_STORAGE_OBJECT_CHANGED');
    expect(await codeOf(() => s3.streamRange('v', [0, 1], before))).toBe(
      'X_STORAGE_OBJECT_CHANGED',
    );
    const now = { etag: (await s3.stat('v'))?.etag ?? '' };
    expect(await drain(await s3.streamRange('v', [0, 5], now))).toBe('second');
  });

  test('streamRange is the window get() answers, clamped, and refuses what is no range', async () => {
    await s3.put(KEY, bytesOf('01234567'));
    for (const range of [
      [0, 0],
      [2, 5],
      [7, 7],
    ] as const) {
      expect(await drain(await s3.streamRange(KEY, range))).toBe(
        textOf((await s3.get(KEY, { range })).bytes),
      );
    }
    expect(await drain(await s3.streamRange(KEY, [5, 1_000_000]))).toBe('567');
    const past = await refusal(() => s3.streamRange(KEY, [8, 9]));
    expect([past.code, past.fix.includes('disk.stat(')]).toEqual([
      'X_STORAGE_RANGE_UNSATISFIABLE',
      true,
    ]);
    for (const range of [[5, 2], [-1, 2], [0.5, 2], [0], 'bytes=0-1']) {
      const bad = await refusal(() =>
        s3.streamRange(KEY, range as unknown as readonly [number, number]),
      );
      expect([bad.code, bad.cause.includes('streamRange()')]).toEqual(['X_INVARIANT', true]);
    }
    expect(await codeOf(() => s3.streamRange('../up', [0, 1]))).toBe('X_STORAGE_PATH_UNSAFE');
  });
});

describe('writes', () => {
  test('a header value with a line break is refused before a byte moves', async () => {
    const injected = 'text/html\r\nx-evil: 1';
    for (const options of [{ contentType: injected }, { cacheControl: injected }]) {
      expect(await codeOf(() => s3.put('h', bytesOf('x'), options))).toBe('X_INVARIANT');
      const body = streamOf(bytesOf('x'));
      expect(await codeOf(() => s3.putStream('h', body, { maxBytes: 8, ...options }))).toBe(
        'X_INVARIANT',
      );
    }
    expect(await s3.exists('h')).toBe(false);
  });

  test('a list limit is a page size or X_INVARIANT, and no maxKeys 0 reaches the provider', async () => {
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      expect(await codeOf(() => s3.list({ limit }))).toBe('X_INVARIANT');
    }
    await s3.list({ limit: 1 });
    expect(fake.listCalls.every((call) => (call.maxKeys ?? 1) > 0)).toBe(true);
  });

  test('putStream round-trips past maxPutBytes, cacheControl and metadata included', async () => {
    const object = await s3.putStream(KEY, streamOf(bytesOf('hello '), bytesOf('stream')), {
      maxBytes: 64,
      contentType: 'text/plain',
      cacheControl: 'public, max-age=60',
      metadata: { uploadedBy: 'user-1' },
    });
    expect([object.size, object.contentType, object.cacheControl, object.metadata]).toEqual([
      12,
      'text/plain',
      'public, max-age=60',
      { uploadedBy: 'user-1' },
    ]);
    expect(await drain(await s3.stream(KEY))).toBe('hello stream');
    expect(await codeOf(() => s3.put('capped', bytesOf('x'.repeat(MAX_PUT + 1))))).toBe(
      'X_STORAGE_TOO_LARGE',
    );
  });

  test('a body across many chunks lands every chunk, in order', async () => {
    const [size, count] = [256 * 1024, 12];
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent === count) return controller.close();
        sent += 1;
        controller.enqueue(new Uint8Array(size).fill(sent));
      },
    });
    await s3.putStream(KEY, body, { maxBytes: size * count });
    const stored = new Uint8Array(await new Response(await s3.stream(KEY)).arrayBuffer());
    expect(Array.from({ length: count }, (_, at) => stored[at * size + size - 1])).toEqual(
      Array.from({ length: count }, (_, at) => at + 1),
    );
  });

  test('an overrun cancels the source, says maxBytes, and keeps what the key held', async () => {
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull: (controller) => controller.enqueue(bytesOf('0123456789')),
      cancel: () => {
        cancelled = true;
      },
    });
    const overrun = await refusal(() => s3.putStream('new', endless, { maxBytes: 16 }));
    expect([overrun.code, overrun.fix.includes('maxBytes'), cancelled]).toEqual([
      'X_STORAGE_TOO_LARGE',
      true,
      true,
    ]);
    expect(await s3.exists('new')).toBe(false);
    await s3.put('old', bytesOf('previous'));
    const over = streamOf(bytesOf('0123456789'), bytesOf('0123456789'));
    expect(await codeOf(() => s3.putStream('old', over, { maxBytes: 16 }))).toBe(
      'X_STORAGE_TOO_LARGE',
    );
    expect(textOf((await s3.get('old')).bytes)).toBe('previous');
  });

  test('a source that dies mid-body is X_STORAGE_PUT_FAILED and leaves nothing', async () => {
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) controller.error(new TypeError('the client went away'));
        else controller.enqueue(bytesOf('partial'));
        sent = true;
      },
    });
    expect(await codeOf(() => s3.putStream(KEY, body, { maxBytes: 64 }))).toBe(
      'X_STORAGE_PUT_FAILED',
    );
    expect(await s3.exists(KEY)).toBe(false);
  });

  test('putStream screens maxBytes, its body, and what needs the bytes up front', async () => {
    const refused = (options: unknown, body: unknown = streamOf()) =>
      refusal(() =>
        s3.putStream(KEY, body as ReadableStream<Uint8Array>, options as { maxBytes: number }),
      );
    for (const maxBytes of [undefined, 0, -1, 1.5, Number.NaN]) {
      expect((await refused({ maxBytes })).code).toBe('X_INVARIANT');
    }
    for (const extra of [
      { checksum: 'abc' },
      { legalHold: true },
      { retention: { mode: 'GOVERNANCE', retainUntil: new Date(0) } },
      { serverSideEncryption: { algorithm: 'AES256' } },
    ]) {
      const upFront = await refused({ maxBytes: 64, ...extra });
      expect([upFront.code, upFront.fix.includes('disk.put(')]).toEqual(['X_INVARIANT', true]);
    }
    expect((await refused({ maxBytes: 64, metadata: { n: 1 } })).code).toBe('X_INVARIANT');
    expect((await refused({ maxBytes: 1 }, bytesOf('x'))).code).toBe('X_INVARIANT');
    const strings = new ReadableStream({
      start(controller) {
        controller.enqueue('not bytes');
        controller.close();
      },
    });
    expect((await refused({ maxBytes: 64 }, strings)).code).toBe('X_INVARIANT');
    expect(await s3.exists(KEY)).toBe(false);
  });
});
