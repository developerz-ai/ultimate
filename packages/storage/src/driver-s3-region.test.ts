// A request signed for the wrong region is the DISK misconfigured, and the provider says which
// region it wanted. The driver has to hand that over as a coded refusal with the region in the
// fix — it used to escape `put()` as a bare `S3Error`, and reach `list()`/`delete()` callers with a
// fix about IAM grants that could never help.
//
// The canned error is the one `Bun.S3Client` raised against a real gateway (2026-10-01): a plain
// Error named `S3Error`, the provider's `code`, the provider's sentence, and no status field. AWS
// writes the same sentence with single quotes.

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { s3Driver } from './driver-s3';
import type { S3ClientLike, S3FileLike } from './driver-s3-client';
import { bytesOf, catchError } from './driver-s3-fixture';

const wrongRegion = (sent: string, expected: string, quote = '"'): Error =>
  Object.assign(
    new Error(
      `The authorization header is malformed; the region ${quote}${sent}${quote} is wrong; expecting ${quote}${expected}${quote}`,
    ),
    { name: 'S3Error', code: 'AuthorizationHeaderMalformed' },
  );

/** A provider that refuses every signed request the way a region mismatch does. */
const refusing = (error: Error): S3ClientLike => {
  const refuse = async (): Promise<never> => {
    throw error;
  };
  const file: S3FileLike = {
    write: refuse,
    arrayBuffer: refuse,
    // A HEAD carries no body, so the provider's sentence never reaches these two.
    exists: async () => true,
    stat: async () => ({ size: 1 }),
    delete: refuse,
    stream: () => new ReadableStream<Uint8Array>(),
    presign: () => 'https://fake.example/signed',
  };
  return { file: () => file, list: refuse };
};

const shapeOf = (caught: unknown): { code: string; cause: string; fix: string } =>
  isUltimateError(caught)
    ? { code: caught.code, cause: caught.cause, fix: caught.fix }
    : { code: `not coded: ${String(caught)}`, cause: '', fix: '' };

describe('unit · s3 driver · a region mismatch names the region to set', () => {
  const disk = s3Driver({ bucket: 'b', client: refusing(wrongRegion('auto', 'us-east-1')) });

  test('put is X_CONFIG_INVALID, with both regions in the cause and S3_REGION in the fix', async () => {
    const refused = shapeOf(await catchError(() => disk.put('a.txt', bytesOf('x'))));

    expect(refused.code).toBe('X_CONFIG_INVALID');
    expect(refused.cause).toContain('"auto"');
    expect(refused.cause).toContain('"us-east-1"');
    expect(refused.fix).toStartWith('set S3_REGION=us-east-1 in .env');
  });

  test('copy, list and delete answer the same way — never a fix about IAM grants', async () => {
    for (const call of [
      () => disk.copy('a.txt', 'b.txt'),
      () => disk.list(),
      () => disk.delete('a.txt'),
    ]) {
      const refused = shapeOf(await catchError(call));
      expect(refused.code).toBe('X_CONFIG_INVALID');
      expect(refused.fix).toStartWith('set S3_REGION=us-east-1 in .env');
      expect(refused.fix).not.toContain('grant');
    }
  });

  test('AWS’s single-quoted sentence is read the same way', async () => {
    const aws = s3Driver({
      bucket: 'b',
      client: refusing(wrongRegion('us-east-1', 'eu-west-1', "'")),
    });

    const refused = shapeOf(await catchError(() => aws.put('a.txt', bytesOf('x'))));

    expect(refused.code).toBe('X_CONFIG_INVALID');
    expect(refused.fix).toStartWith('set S3_REGION=eu-west-1 in .env');
  });

  test('a region the sentence does not spell as a region name is never pasted into a fix', async () => {
    const hostile = s3Driver({
      bucket: 'b',
      client: refusing(wrongRegion('auto', 'x; rm -rf /')),
    });

    const refused = shapeOf(await catchError(() => hostile.list()));

    // Still a refused listing, with the driver's ordinary fix: nothing was recognised.
    expect(refused.code).toBe('X_STORAGE_LIST_FAILED');
    expect(refused.fix).not.toContain('rm -rf');
  });

  test('any other refusal keeps the code it had', async () => {
    const denied = s3Driver({
      bucket: 'b',
      client: refusing(
        Object.assign(new Error('denied'), { name: 'S3Error', code: 'AccessDenied' }),
      ),
    });

    expect(shapeOf(await catchError(() => denied.list())).code).toBe('X_STORAGE_LIST_FAILED');
    expect(shapeOf(await catchError(() => denied.delete('a.txt'))).code).toBe(
      'X_STORAGE_DELETE_FAILED',
    );
  });
});
