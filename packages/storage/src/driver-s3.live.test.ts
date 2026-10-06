// The only proof `s3Driver` works against a server. Every other test in this package drives it over
// `FakeS3Client`, which cannot refuse a request the way a provider does: the wire format, the
// signature, the listing's continuation token and a presigned URL's signed headers were all proved
// by a fake that agrees with the driver by construction.
//
// Skips unless an S3 endpoint is configured. Locally, in RAM, with the bucket ready:
//
//   docker compose -f docker/docker-compose.test.yml up -d --wait s3
//   TEST_S3_URL=http://ultimate:ultimate-test@localhost:9000/ultimate-test \
//     bun test packages/storage/src/driver-s3.live.test.ts
//
// ONE variable, shaped like `TEST_DATABASE_URL`: userinfo is the key pair, the path is the bucket.
// The bucket must already exist — `Bun.S3Client` has no CreateBucket, and it refuses to presign a
// bucket root (`ERR_S3_INVALID_PATH`), so this file cannot make one.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type Clock, isUltimateError, markListening } from '@ultimat3/core';
import type { StorageDriver } from './driver';
import { sha256Base64 } from './driver';
import { s3Driver } from './driver-s3';
import { bytesOf, catchError, codeOf, textOf } from './driver-s3-fixture';

interface Target {
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/** `http://<key>:<secret>@host:port/<bucket>`, or nothing: a half-configured URL skips, never guesses. */
const targetOf = (raw: string | undefined): Target | undefined => {
  if (raw === undefined || raw === '') return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const bucket = url.pathname.replace(/^\/+|\/+$/g, '');
  if (bucket === '' || url.username === '' || url.password === '') return undefined;
  return {
    endpoint: url.origin,
    bucket,
    accessKeyId: decodeURIComponent(url.username),
    secretAccessKey: decodeURIComponent(url.password),
  };
};

const target = targetOf(Bun.env['TEST_S3_URL']);

/**
 * The WALL clock. The preload freezes `Date`, and a signed request dated at the frozen instant is
 * `RequestTimeTooSkewed` — the server's clock is real. `performance` is not frozen.
 */
const wallClock: Clock = {
  now: () => new Date(performance.timeOrigin + performance.now()),
  monotonic: () => performance.now(),
};

/** One namespace per run: a shared bucket survives two runs at once, and a run that died. */
const PREFIX = `xlive-${crypto.randomUUID()}`;
const at = (name: string): string => `${PREFIX}/${name}`;

describe.skipIf(target === undefined)('live · s3 · the driver against a real server', () => {
  let disk: StorageDriver;
  let release: () => void = () => undefined;

  beforeAll(() => {
    if (target === undefined) return;
    disk = s3Driver({
      bucket: target.bucket,
      endpoint: target.endpoint,
      // No `region`, on purpose: what an app that sets no S3_REGION sends, which the dev and test
      // gateways are started to accept. A stack that stops accepting it is red here.
      forcePathStyle: true,
      env: {
        S3_ACCESS_KEY_ID: target.accessKeyId,
        S3_SECRET_ACCESS_KEY: target.secretAccessKey,
      },
      clock: wallClock,
    });
    // A presigned URL is only proved by an HTTP request, and the preload seals `fetch`. The origin
    // is the service this run was handed, on the same footing as a server this process booted —
    // announced through core rather than `@ultimat3/testing`'s `allowHost`, which tier 1 may not
    // import.
    release = markListening(target.endpoint);
  });

  afterAll(async () => {
    if (target === undefined) return;
    let cursor: string | undefined;
    do {
      const page = await disk.list({ prefix: `${PREFIX}/`, limit: 100, cursor });
      for (const entry of page.objects) await disk.delete(entry.key);
      cursor = page.cursor;
    } while (cursor !== undefined);
    release();
  });

  test('put → get round-trips the bytes, the size and the content type', async () => {
    const written = await disk.put(at('a.txt'), bytesOf('hello'), { contentType: 'text/plain' });

    expect(written.size).toBe(5);
    expect(written.contentType).toStartWith('text/plain');
    expect(written.etag).not.toBe('');

    const read = await disk.get(at('a.txt'));
    expect(textOf(read.bytes)).toBe('hello');
    expect(read.object.contentType).toStartWith('text/plain');
    expect(await disk.exists(at('a.txt'))).toBe(true);
  });

  test('a claimed checksum is checked before the object exists', async () => {
    const bytes = bytesOf('checked');
    await disk.put(at('sum.txt'), bytes, { checksum: sha256Base64(bytes) });
    const refused = await catchError(() =>
      disk.put(at('sum-bad.txt'), bytes, { checksum: sha256Base64(bytesOf('other')) }),
    );

    expect(codeOf(refused)).toBe('X_STORAGE_CHECKSUM_MISMATCH');
    expect(await disk.exists(at('sum-bad.txt'))).toBe(false);
  });

  test('a missing key is X_STORAGE_NOT_FOUND on get and stream, and false on exists', async () => {
    expect(await disk.exists(at('nope'))).toBe(false);
    expect(codeOf(await catchError(() => disk.get(at('nope'))))).toBe('X_STORAGE_NOT_FOUND');
    expect(codeOf(await catchError(() => disk.stream(at('nope'))))).toBe('X_STORAGE_NOT_FOUND');
  });

  test('stream yields the object’s bytes', async () => {
    await disk.put(at('stream.bin'), bytesOf('streamed bytes'));

    const body = await new Response(await disk.stream(at('stream.bin'))).text();

    expect(body).toBe('streamed bytes');
  });

  test('an object past one part round-trips byte for byte', async () => {
    // 6 MiB: over the 5 MiB S3 part floor, under the driver's 10 MiB `maxPutBytes`.
    const big = new Uint8Array(6 * 1024 * 1024);
    for (let index = 0; index < big.length; index += 4096) big[index] = index % 251;

    const written = await disk.put(at('big.bin'), big, { contentType: 'application/octet-stream' });
    const read = await disk.get(at('big.bin'));

    expect(written.size).toBe(big.length);
    expect(sha256Base64(read.bytes)).toBe(sha256Base64(big));
  });

  test('copy moves the bytes and the content type; a missing source writes nothing', async () => {
    await disk.put(at('src.json'), bytesOf('{"a":1}'), { contentType: 'application/json' });

    const copied = await disk.copy(at('src.json'), at('dst.json'));
    const missing = await catchError(() => disk.copy(at('absent.json'), at('never.json')));

    expect(copied.size).toBe(7);
    expect(copied.contentType).toStartWith('application/json');
    expect(textOf((await disk.get(at('dst.json'))).bytes)).toBe('{"a":1}');
    expect(codeOf(missing)).toBe('X_STORAGE_NOT_FOUND');
    expect(await disk.exists(at('never.json'))).toBe(false);
  });

  test('delete removes the object, and deleting an absent key is success', async () => {
    await disk.put(at('gone.txt'), bytesOf('x'));

    await disk.delete(at('gone.txt'));
    await disk.delete(at('gone.txt'));
    await disk.delete(at('never-existed.txt'));

    expect(await disk.exists(at('gone.txt'))).toBe(false);
  });

  test('list scopes to the prefix and pages every key exactly once', async () => {
    const names = ['p/1', 'p/2', 'p/3', 'p/4', 'p/5'];
    for (const name of names) await disk.put(at(name), bytesOf(name));
    await disk.put(at('q/outside'), bytesOf('outside'));

    const seen: string[] = [];
    let pages = 0;
    let cursor: string | undefined;
    do {
      const page = await disk.list({ prefix: at('p/'), limit: 2, cursor });
      expect(page.objects.length).toBeLessThanOrEqual(2);
      for (const entry of page.objects) {
        seen.push(entry.key);
        expect(entry.size).toBe(3);
      }
      expect(page.truncated).toBe(page.cursor !== undefined);
      cursor = page.cursor;
      pages += 1;
    } while (cursor !== undefined && pages < 10);

    expect(seen.sort()).toEqual(names.map(at));
    expect(pages).toBe(3);
  });

  test('a presigned GET serves the bytes, and a changed signature is refused', async () => {
    await disk.put(at('signed.txt'), bytesOf('signed read'), { contentType: 'text/plain' });

    const url = await disk.signedUrl(at('signed.txt'), { expiresInMs: 60_000 });
    const served = await fetch(url);
    const forged = await fetch(
      url.replace(/X-Amz-Signature=[0-9a-f]{8}/, 'X-Amz-Signature=00000000'),
    );

    expect(served.status).toBe(200);
    expect(await served.text()).toBe('signed read');
    expect(forged.status).toBe(403);
    await forged.arrayBuffer();
  });

  test('a presigned PUT stores what the browser sends, under the granted content type', async () => {
    const url = await disk.signedUrl(at('upload.png'), {
      method: 'PUT',
      contentType: 'image/png',
      expiresInMs: 60_000,
    });

    const put = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
      body: 'not really a png',
    });
    await put.arrayBuffer();

    expect(put.ok).toBe(true);
    const read = await disk.get(at('upload.png'));
    expect(textOf(read.bytes)).toBe('not really a png');
    expect(read.object.contentType).toStartWith('image/png');
  });

  test('a disk signing for the wrong region is told which region to set', async () => {
    if (target === undefined) return;
    const elsewhere = s3Driver({
      bucket: target.bucket,
      endpoint: target.endpoint,
      region: 'eu-central-1',
      forcePathStyle: true,
      env: {
        S3_ACCESS_KEY_ID: target.accessKeyId,
        S3_SECRET_ACCESS_KEY: target.secretAccessKey,
      },
    });

    const refused = await catchError(() => elsewhere.put(at('region.txt'), bytesOf('x')));

    expect(isUltimateError(refused) ? refused.code : String(refused)).toBe('X_CONFIG_INVALID');
    expect(isUltimateError(refused) ? refused.cause : '').toContain('"eu-central-1"');
    expect(isUltimateError(refused) ? refused.fix : '').toMatch(
      /^set S3_REGION=[a-z0-9-]+ in \.env/,
    );
    expect(await disk.exists(at('region.txt'))).toBe(false);
  });

  test('stat answers size and age without the bytes, and get refuses past maxGetBytes', async () => {
    if (target === undefined) return;
    await disk.put(at('capped.txt'), bytesOf('12345'), { contentType: 'text/plain' });
    const capped = s3Driver({
      bucket: target.bucket,
      endpoint: target.endpoint,
      forcePathStyle: true,
      maxGetBytes: 4,
      env: {
        S3_ACCESS_KEY_ID: target.accessKeyId,
        S3_SECRET_ACCESS_KEY: target.secretAccessKey,
      },
    });

    const stat = await disk.stat(at('capped.txt'));
    const refused = await catchError(() => capped.get(at('capped.txt')));
    const streamed = await new Response(await capped.stream(at('capped.txt'))).text();

    expect(stat?.size).toBe(5);
    expect(stat?.contentType).toStartWith('text/plain');
    // A real provider always dates an object: an absent `lastModified` is for one that does not.
    expect(stat?.lastModified).toBeInstanceOf(Date);
    expect(await disk.stat(at('capped-absent.txt'))).toBeUndefined();
    expect(codeOf(refused)).toBe('X_STORAGE_TOO_LARGE');
    expect(streamed).toBe('12345');
  });

  test('a presigned GET cannot be replayed as a PUT', async () => {
    await disk.put(at('readonly.txt'), bytesOf('original'));
    const url = await disk.signedUrl(at('readonly.txt'), { expiresInMs: 60_000 });

    const put = await fetch(url, { method: 'PUT', body: 'overwritten' });
    await put.arrayBuffer();

    expect(put.status).toBe(403);
    expect(textOf((await disk.get(at('readonly.txt'))).bytes)).toBe('original');
  });

  test('metadata and cache-control travel on the signed PUT and come back as headers', async () => {
    // Off the Bun client: core's `signAwsRequest` signs this one, so the gateway checking it is
    // the proof the signer and the scope agree with a real server, not only with AWS's vectors.
    const written = await disk.put(at('meta.txt'), bytesOf('with headers'), {
      contentType: 'text/plain',
      cacheControl: 'private, max-age=60',
      metadata: { owner: 'ada' },
    });
    expect(written.metadata).toEqual({ owner: 'ada' });
    expect(textOf((await disk.get(at('meta.txt'))).bytes)).toBe('with headers');

    const served = await fetch(await disk.signedUrl(at('meta.txt'), { expiresInMs: 60_000 }));
    expect(served.headers.get('x-amz-meta-owner')).toBe('ada');
    expect(served.headers.get('cache-control')).toBe('private, max-age=60');
    await served.arrayBuffer();
  });

  test('retentionOf on a bucket made without Object Lock reports nothing locking it', async () => {
    await disk.put(at('unlocked.txt'), bytesOf('x'));
    expect(await disk.retentionOf?.(at('unlocked.txt'))).toEqual({ legalHold: false });
    expect(
      codeOf(await catchError(() => disk.retentionOf?.(at('absent.txt')) ?? Promise.resolve())),
    ).toBe('X_STORAGE_NOT_FOUND');
  });
});

/**
 * A bucket CREATED with Object Lock, on the same endpoint and key pair as `TEST_S3_URL`. Opt-in:
 * the plain test gateway has no versioning, and an object locked here cannot be deleted until its
 * retention lapses — so the retention is GOVERNANCE and an hour, and the keys are this run's.
 */
const lockBucket = Bun.env['S3_OBJECT_LOCK_BUCKET'];

describe.skipIf(target === undefined || lockBucket === undefined || lockBucket === '')(
  'live · s3 · Object Lock against a lock-enabled bucket',
  () => {
    let locked: StorageDriver;
    let release: () => void = () => undefined;

    beforeAll(() => {
      if (target === undefined || lockBucket === undefined) return;
      locked = s3Driver({
        bucket: lockBucket,
        endpoint: target.endpoint,
        forcePathStyle: true,
        env: {
          S3_ACCESS_KEY_ID: target.accessKeyId,
          S3_SECRET_ACCESS_KEY: target.secretAccessKey,
        },
        clock: wallClock,
      });
      release = markListening(target.endpoint);
    });

    afterAll(() => release());

    test('a retention and a legal hold are set on put and read back exactly', async () => {
      // Whole seconds: S3 stores the instant at second precision.
      const retainUntil = new Date(
        Math.ceil((wallClock.now().getTime() + 3_600_000) / 1000) * 1000,
      );
      await locked.put(at('locked.txt'), bytesOf('retained'), {
        retention: { mode: 'GOVERNANCE', retainUntil },
        legalHold: true,
      });
      expect(await locked.retentionOf?.(at('locked.txt'))).toEqual({
        retention: { mode: 'GOVERNANCE', retainUntil },
        legalHold: true,
      });
      await locked.put(at('plain.txt'), bytesOf('plain'), { metadata: { a: 'b' } });
      expect(await locked.retentionOf?.(at('plain.txt'))).toEqual({ legalHold: false });
    });
  },
);
