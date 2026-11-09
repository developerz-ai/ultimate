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
