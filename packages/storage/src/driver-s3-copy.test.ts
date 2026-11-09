// A revision-bound copy on the s3 disk: what goes on the wire, and each answer the provider can give
// to it. The fake answers as S3 does, so the driver's classification of a refusal is what is tested.

import { describe, expect, test } from 'bun:test';
import { s3Driver } from './driver-s3';
import { signedCopy } from './driver-s3-copy';
import {
  bytesOf,
  catchError,
  codeOf,
  FAKE_ENV,
  FakeS3Client,
  fakeEtagOf,
  textOf,
} from './driver-s3-fixture';

describe('copy without ifMatch', () => {
  test('is one signed CopyObject, so cacheControl and x-amz-meta-* travel — as on local and memory', async () => {
    const fake = new FakeS3Client();
    const driver = s3Driver({ bucket: 'b', client: fake, fetch: fake.fetch, env: FAKE_ENV });
    await driver.put('org/o/a.txt', bytesOf('hello'), {
      contentType: 'text/plain',
      cacheControl: 'max-age=60',
      metadata: { owner: 'u-1' },
    });
    const copied = await driver.copy('org/o/a.txt', 'org/o/c.txt');
    const call = fake.signedCalls.at(-1);
    expect(call?.headers['x-amz-copy-source']).toBe('/b/org/o/a.txt');
    expect(call?.headers['x-amz-copy-source-if-match']).toBeUndefined();
    // S3's default directive is COPY: the provider carries the source's headers itself.
    expect(call?.headers['x-amz-metadata-directive']).toBeUndefined();
    expect(fake.headersOf.get('org/o/c.txt')?.['cache-control']).toBe('max-age=60');
    expect(fake.headersOf.get('org/o/c.txt')?.['x-amz-meta-owner']).toBe('u-1');
    expect(copied.contentType).toBe('text/plain');
    expect(textOf((await driver.get('org/o/c.txt')).bytes)).toBe('hello');
  });
});

describe('copy with ifMatch', () => {
  const wired = () => {
    const fake = new FakeS3Client();
    return {
      fake,
      driver: s3Driver({ bucket: 'b', client: fake, fetch: fake.fetch, env: FAKE_ENV }),
    };
  };

  test('sends the condition on one signed CopyObject, and the copy lands', async () => {
    const { fake, driver } = wired();
    const put = await driver.put('org/o/a b.txt', bytesOf('hello'), {
      contentType: 'text/plain',
    });
    expect(put.key).toBe('org/o/a b.txt');
    const entry = fake.store.get('org/o/a b.txt');
    if (entry !== undefined) entry.etag = fakeEtagOf(entry);
    const stated = await driver.stat('org/o/a b.txt');
    const copied = await driver.copy('org/o/a b.txt', 'org/o/c.txt', { ifMatch: stated?.etag });
    const call = fake.signedCalls.at(-1);
    expect(call?.method).toBe('PUT');
    expect(call?.headers['x-amz-copy-source']).toBe('/b/org/o/a%20b.txt');
    expect(call?.headers['x-amz-copy-source-if-match']).toBe(stated?.etag);
    expect(copied.key).toBe('org/o/c.txt');
    expect(textOf((await driver.get('org/o/c.txt')).bytes)).toBe('hello');
  });

  test('another revision is X_STORAGE_OBJECT_CHANGED, and a gone source X_STORAGE_NOT_FOUND', async () => {
    const { driver } = wired();
    await driver.put('org/o/a.txt', bytesOf('hello'), { contentType: 'text/plain' });
    const changed = await catchError(() =>
      driver.copy('org/o/a.txt', 'org/o/c.txt', { ifMatch: '"stale"' }),
    );
    expect(codeOf(changed)).toBe('X_STORAGE_OBJECT_CHANGED');
    expect(await driver.exists('org/o/c.txt')).toBe(false);
    const gone = await catchError(() =>
      driver.copy('org/o/none.txt', 'org/o/c.txt', { ifMatch: '"x"' }),
    );
    expect(codeOf(gone)).toBe('X_STORAGE_NOT_FOUND');
  });

  test('an <Error> inside a 200 is the refusal it says it is, never a landed copy', async () => {
    const refusal = await signedCopy(
      {
        bucket: 'b',
        env: FAKE_ENV,
        fetch: async () => new Response('<Error><Code>InternalError</Code></Error>'),
      },
      'a',
      'b',
      '"e"',
    );
    expect(refusal?.code).toBe('InternalError');
  });
});
