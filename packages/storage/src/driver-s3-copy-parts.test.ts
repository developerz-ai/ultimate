// A copy past CopyObject's 5 GiB ceiling, at a few bytes per part: the source's headers travel on
// the Create, every part is pinned to one revision, and a failed copy leaves no upload open.

import { describe, expect, test } from 'bun:test';
import type { PutOptions } from './driver';
import { s3Driver } from './driver-s3';
import { COPY_PART_BYTES, copyPartBytes, copyS3, copyS3InParts } from './driver-s3-copy-parts';
import { bytesOf, FAKE_ENV, FakeS3Client, s3Error, textOf } from './driver-s3-fixture';
import type { S3FetchLike, S3Refusal } from './driver-s3-signed';

class Refused {
  constructor(readonly refusal: S3Refusal) {}
}

const wired = async (
  attributes: PutOptions = {
    contentType: 'application/x-big',
    cacheControl: 'max-age=60',
    metadata: { owner: 'u-1' },
  },
  send?: (fake: FakeS3Client) => S3FetchLike,
) => {
  const fake = new FakeS3Client();
  const wire = { bucket: 'b', env: FAKE_ENV, fetch: send === undefined ? fake.fetch : send(fake) };
  const disk = s3Driver({ ...wire, client: fake });
  await disk.put('org/o/big.bin', bytesOf('abcdefghij'), attributes);
  const stat = (key: string) => disk.stat(key);
  const target = {
    wire,
    key: 'org/o/copy.bin',
    refused: (refusal: S3Refusal): never => {
      throw new Refused(refusal);
    },
  };
  return { fake, target, stat };
};

describe('copyS3InParts', () => {
  test('copies every range in order and carries type, cache-control and metadata', async () => {
    const { fake, target, stat } = await wired();
    await copyS3InParts(target, { source: 'org/o/big.bin', stat, partBytes: 3 });
    const copied = fake.store.get('org/o/copy.bin');
    expect(textOf(copied?.bytes ?? new Uint8Array())).toBe('abcdefghij');
    expect(copied?.type).toBe('application/x-big');
    const create = fake.signedCalls.find((call) => call.url.searchParams.has('uploads'));
    expect(create?.headers['cache-control']).toBe('max-age=60');
    expect(create?.headers['x-amz-meta-owner']).toBe('u-1');
    const ranges = fake.signedCalls
      .map((call) => call.headers['x-amz-copy-source-range'])
      .filter((range) => range !== undefined)
      .sort();
    expect(ranges).toEqual(['bytes=0-2', 'bytes=3-5', 'bytes=6-8', 'bytes=9-9']);
    expect(fake.openUploads()).toEqual([]);
  });

  test('every part is pinned to the revision the HEAD saw', async () => {
    const { fake, target, stat } = await wired();
    await copyS3InParts(target, { source: 'org/o/big.bin', stat, partBytes: 4 });
    const pins = fake.signedCalls
      .filter((call) => call.headers['x-amz-copy-source-range'] !== undefined)
      .map((call) => call.headers['x-amz-copy-source-if-match']);
    expect(pins.length).toBe(3);
    expect(new Set(pins).size).toBe(1);
    expect(pins[0]).toStartWith('"');
  });

  test('a stale ifMatch is the 412 before anything opens', async () => {
    const { fake, target, stat } = await wired();
    const caught = await copyS3InParts(target, {
      source: 'org/o/big.bin',
      stat,
      ifMatch: '"stale"',
      partBytes: 4,
    }).catch((error: unknown) => error);
    expect(caught instanceof Refused ? caught.refusal.statusCode : 0).toBe(412);
    expect(fake.signedCalls.some((call) => call.url.searchParams.has('uploads'))).toBe(false);
  });

  test('a part refused mid-copy aborts the upload: nothing is left billing', async () => {
    const { fake, target, stat } = await wired();
    fake.failPartWith = s3Error('SlowDown', 503, 'org/o/copy.bin');
    const caught = await copyS3InParts(target, {
      source: 'org/o/big.bin',
      stat,
      partBytes: 4,
    }).catch((error: unknown) => error);
    expect(caught instanceof Refused ? caught.refusal.code : '').toBe('SlowDown');
    expect(fake.openUploads()).toEqual([]);
    expect(fake.store.has('org/o/copy.bin')).toBe(false);
  });
});

describe('copyS3InParts, when a part or the Complete goes wrong', () => {
  test('a refused part stops its siblings, and every one in flight settles before the abort', async () => {
    const events: string[] = [];
    const { fake, target, stat } = await wired(undefined, (fake) => async (url, init) => {
      const part = new URL(url).searchParams.get('partNumber');
      if (init.method === 'DELETE') events.push('abort');
      if (part === null || init.method !== 'PUT') return fake.fetch(url, init);
      events.push(`start ${part}`);
      if (part === '1') {
        return new Response('<Error><Code>SlowDown</Code><Message>slow</Message></Error>', {
          status: 503,
        });
      }
      // Held for a few event-loop turns: long enough that part 1's refusal arrives first.
      for (let turn = 0; turn < 5; turn += 1)
        await new Promise((resolve) => setTimeout(resolve, 0));
      events.push(`end ${part}`);
      return fake.fetch(url, init);
    });
    const caught = await copyS3InParts(target, {
      source: 'org/o/big.bin',
      stat,
      partBytes: 1,
    }).catch((error: unknown) => error);
    expect(caught instanceof Refused ? caught.refusal.code : '').toBe('SlowDown');
    // Four started together; part 1's refusal stopped the other six from ever starting.
    expect(events.filter((event) => event.startsWith('start')).length).toBe(4);
    // Every sibling ended before the abort went out.
    expect(events.at(-1)).toBe('abort');
    expect(fake.openUploads()).toEqual([]);
  });

  test('a lost Complete that landed is settled by the stat: the copy resolves', async () => {
    const { fake, target, stat } = await wired({ contentType: 'application/x-big' });
    fake.loseAnswerOf = 'complete-after';
    await copyS3InParts(target, { source: 'org/o/big.bin', stat, partBytes: 4 });
    expect(textOf(fake.store.get('org/o/copy.bin')?.bytes ?? new Uint8Array())).toBe('abcdefghij');
  });

  test('a lost Complete that never arrived is the lost answer, aborted, nothing stored', async () => {
    const { fake, target, stat } = await wired({ contentType: 'application/x-big' });
    fake.loseAnswerOf = 'complete-before';
    const caught = await copyS3InParts(target, {
      source: 'org/o/big.bin',
      stat,
      partBytes: 4,
    }).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(TypeError);
    expect(fake.openUploads()).toEqual([]);
    expect(fake.store.has('org/o/copy.bin')).toBe(false);
  });
});

describe('copyS3InParts, when the provider answers with nothing to go on', () => {
  const refusalOf = (caught: unknown): string =>
    caught instanceof Refused ? caught.refusal.code : `not refused: ${String(caught)}`;

  test('a HEAD with no Content-Length is refused before any upload opens', async () => {
    const { fake, target, stat } = await wired(
      undefined,
      (fake) => async (url, init) =>
        init.method === 'HEAD'
          ? new Response(null, { status: 200, headers: { etag: '"e"' } })
          : fake.fetch(url, init),
    );
    const caught = await copyS3InParts(target, {
      source: 'org/o/big.bin',
      stat,
      partBytes: 4,
    }).catch((error: unknown) => error);
    expect(refusalOf(caught)).toBe('UnreadableAnswer');
    expect(fake.signedCalls.some((call) => call.url.searchParams.has('uploads'))).toBe(false);
  });

  test('an UploadPartCopy answered 200 with an <Error> body is that refusal, and aborted', async () => {
    const { fake, target, stat } = await wired(
      undefined,
      (fake) => async (url, init) =>
        new URL(url).searchParams.has('partNumber') && init.method === 'PUT'
          ? new Response('<Error><Code>InternalError</Code><Message>copy failed</Message></Error>')
          : fake.fetch(url, init),
    );
    const caught = await copyS3InParts(target, {
      source: 'org/o/big.bin',
      stat,
      partBytes: 4,
    }).catch((error: unknown) => error);
    expect(refusalOf(caught)).toBe('InternalError');
    expect(fake.openUploads()).toEqual([]);
  });

  test('a lost Complete over a source with metadata a HEAD cannot prove is said to be unknown', async () => {
    const { fake, target, stat } = await wired();
    fake.loseAnswerOf = 'complete-after';
    const caught = await copyS3InParts(target, {
      source: 'org/o/big.bin',
      stat,
      partBytes: 4,
    }).catch((error: unknown) => error);
    expect(caught).toBeUltimateError('X_STORAGE_WRITE_OUTCOME_UNKNOWN');
  });
});

describe('copyS3InParts, when the abort is lost too', () => {
  test('the part’s refusal is what the caller reads, not the abort’s lost answer', async () => {
    const { fake, target, stat } = await wired();
    fake.failPartWith = s3Error('SlowDown', 503, 'org/o/copy.bin');
    fake.loseAnswerOf = 'abort-before';
    const caught = await copyS3InParts(target, {
      source: 'org/o/big.bin',
      stat,
      partBytes: 4,
    }).catch((error: unknown) => error);
    expect(caught instanceof Refused ? caught.refusal.code : 'not the part refusal').toBe(
      'SlowDown',
    );
  });
});

describe('copyS3', () => {
  test('a source past CopyObject’s 5 GiB ceiling goes in parts, never one CopyObject', async () => {
    const { fake, target, stat } = await wired();
    await copyS3(
      target.wire,
      {
        source: 'org/o/big.bin',
        destination: 'org/o/copy.bin',
        ifMatch: undefined,
        size: 6 * 1024 ** 3,
        stat,
      },
      target.refused,
    );
    const ranged = fake.signedCalls.filter((call) => call.headers['x-amz-copy-source-range']);
    expect(ranged.length).toBe(1);
    expect(textOf(fake.store.get('org/o/copy.bin')?.bytes ?? new Uint8Array())).toBe('abcdefghij');
  });

  test('a source under the ceiling is one CopyObject, and its refusal goes to `refused`', async () => {
    const { fake, target, stat } = await wired();
    const caught = await copyS3(
      target.wire,
      {
        source: 'org/o/big.bin',
        destination: 'org/o/copy.bin',
        ifMatch: '"stale"',
        size: 10,
        stat,
      },
      target.refused,
    ).catch((error: unknown) => error);
    expect(caught instanceof Refused ? caught.refusal.statusCode : 0).toBe(412);
    expect(fake.signedCalls.some((call) => call.headers['x-amz-copy-source-range'])).toBe(false);
  });
});

describe('copyPartBytes', () => {
  test('512 MiB until 10,000 of them cannot hold the object, then grown', () => {
    expect(copyPartBytes(6 * 1024 ** 3)).toBe(COPY_PART_BYTES);
    expect(copyPartBytes(5 * 1024 ** 4)).toBe(Math.ceil((5 * 1024 ** 4) / 10_000));
  });
});
