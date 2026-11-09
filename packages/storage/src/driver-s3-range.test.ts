// The ranged read's body failure: whatever the transport rejects with — an Error, or a value whose
// own `toString` throws — becomes the disk's coded read failure, never an uncoded escape.

import { describe, expect, test } from 'bun:test';
import { FAKE_ENV } from './driver-s3-fixture';
import { readS3Range, type S3RangeDeps } from './driver-s3-range';
import type { S3FetchLike } from './driver-s3-signed';
import { objectNotFound } from './errors';

/** Input, not a verdict: a rejection whose own `toString` throws — a coded one, so nothing is bare. */
const hostile = {
  toString(): string {
    throw objectNotFound('s3', 'a rejection that refuses to be printed');
  },
};

/** A 206 whose headers arrive and whose body rejects with `thrown`. */
const brokenBody =
  (thrown: unknown): S3FetchLike =>
  async () => {
    const response = new Response(new Uint8Array(4), {
      status: 206,
      headers: { 'content-range': 'bytes 0-3/10' },
    });
    Object.defineProperty(response, 'arrayBuffer', { value: () => Promise.reject(thrown) });
    return response;
  };

class Unreadable {
  constructor(readonly why: string) {}
}

const deps: S3RangeDeps = {
  driver: 's3',
  maxGetBytes: 1024,
  refused: () => {
    throw expect.unreachable('the GET was answered');
  },
  sizeOf: async () => 10,
  unreadable: (_key, why) => {
    throw new Unreadable(why);
  },
};

describe('readS3Range — a body that breaks mid-read', () => {
  test.each([
    ['an Error', new TypeError('socket reset'), 'socket reset'],
    ['a value whose toString throws', hostile, 'mid-read'],
  ])('%s is the disk’s unreadable answer', async (_label, thrown, says) => {
    const wire = { bucket: 'b', env: FAKE_ENV, fetch: brokenBody(thrown) };
    const caught = await readS3Range(wire, 'a.bin', [0, 3], deps).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(Unreadable);
    expect((caught as Unreadable).why).toContain(says);
  });
});

describe('readS3Range — an answer that is not the window asked', () => {
  const answering =
    (
      body: Uint8Array<ArrayBuffer> | null,
      status: number,
      headers: Record<string, string>,
    ): S3FetchLike =>
    async () =>
      new Response(body, { status, headers });
  const read = (fetch: S3FetchLike, range: readonly [number, number], maxGetBytes = 1024) =>
    readS3Range({ bucket: 'b', env: FAKE_ENV, fetch }, 'a.bin', [range[0], range[1]], {
      ...deps,
      maxGetBytes,
    }).catch((error: unknown) => error);
  const why = (caught: unknown): string =>
    caught instanceof Unreadable ? caught.why : `not unreadable: ${String(caught)}`;

  test('a 416 is the range code, sized by the HEAD', async () => {
    const caught = await read(answering(null, 416, {}), [20, 30]);
    expect(caught).toBeUltimateError('X_STORAGE_RANGE_UNSATISFIABLE');
  });

  test('a 200 with no Content-Range is unreadable, never the whole object as the window', async () => {
    expect(why(await read(answering(new Uint8Array(10), 200, {}), [0, 3]))).toContain(
      'answered 200 with no byte range',
    );
  });

  test('another window than the one asked is unreadable', async () => {
    const shifted = answering(new Uint8Array(4), 206, { 'content-range': 'bytes 2-5/10' });
    expect(why(await read(shifted, [0, 3]))).toContain('answered 2-5');
  });

  test('a range past maxGetBytes over an object that goes on is the too-large code', async () => {
    const capped = answering(new Uint8Array(4), 206, { 'content-range': 'bytes 0-3/100' });
    expect(await read(capped, [0, 50], 4)).toBeUltimateError('X_STORAGE_TOO_LARGE');
  });

  test('a body shorter than its Content-Range is unreadable', async () => {
    const short = answering(new Uint8Array(2), 206, { 'content-range': 'bytes 0-3/10' });
    expect(why(await read(short, [0, 3]))).toContain('promised 4B, the body held 2B');
  });
});
