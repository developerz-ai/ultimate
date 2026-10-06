// The s3 disk's SIGNED requests: a `put()` carrying metadata, cache-control or an Object Lock goes
// past the Bun client as one SigV4-signed PUT, and `retentionOf()` reads `?retention` and
// `?legal-hold` back. Driven over `FakeS3Client.fetch`, which answers in S3's own XML shapes, so
// what is under test is the headers on the wire and the driver's reading of the provider's answer.

import { describe, expect, test } from 'bun:test';
import { frozenClock, isUltimateError, signAwsRequest } from '@ultimat3/core';
import type { S3DriverOptions } from './driver-s3';
import { s3Driver } from './driver-s3';
import { bytesOf, catchError, FAKE_ENV, FakeS3Client, s3Error } from './driver-s3-fixture';

const KEY = 'org/o1/ledger.csv';
const clock = frozenClock('2026-10-06T09:00:00.000Z');
const retainUntil = new Date('2026-10-07T09:00:00.000Z');
const codeOf = (thrown: unknown): string =>
  isUltimateError(thrown) ? thrown.code : `uncoded: ${String(thrown)}`;

function disk(overrides: Partial<S3DriverOptions> = {}) {
  const fake = new FakeS3Client();
  const driver = s3Driver({
    bucket: 'b',
    client: fake,
    fetch: fake.fetch,
    env: FAKE_ENV,
    clock,
    ...overrides,
  });
  return { fake, driver };
}

describe('put() with headers the Bun client cannot send', () => {
  test('one signed PUT carries the lock, the metadata and the cache-control', async () => {
    const { fake, driver } = disk();
    const body = bytesOf('a,b\n1,2\n');
    const stored = await driver.put(KEY, body, {
      contentType: 'text/csv',
      cacheControl: 'private, max-age=60',
      metadata: { Owner: 'ada' },
      retention: { mode: 'COMPLIANCE', retainUntil },
      legalHold: true,
    });
    expect(fake.signedCalls).toHaveLength(1);
    const call = fake.signedCalls[0];
    expect(call?.method).toBe('PUT');
    expect(call?.url.href).toBe('https://s3.us-east-1.amazonaws.com/b/org/o1/ledger.csv');
    expect(call?.headers).toMatchObject({
      'content-type': 'text/csv',
      'cache-control': 'private, max-age=60',
      'x-amz-meta-owner': 'ada',
      'x-amz-object-lock-mode': 'COMPLIANCE',
      'x-amz-object-lock-retain-until-date': '2026-10-07T09:00:00.000Z',
      'x-amz-object-lock-legal-hold': 'ON',
      'content-md5': new Bun.CryptoHasher('md5').update(body).digest('base64'),
    });
    expect(call?.body).toEqual(body);
    // Stored — so reported, as the local disk reports its sidecar.
    expect(stored).toMatchObject({
      key: KEY,
      size: body.byteLength,
      contentType: 'text/csv',
      cacheControl: 'private, max-age=60',
      metadata: { Owner: 'ada' },
    });
  });

  test('the request is signed by core’s signer, for the disk’s region and credentials', async () => {
    const { fake, driver } = disk({ region: 'eu-west-1', endpoint: 'http://127.0.0.1:9000' });
    await driver.put(KEY, bytesOf('x'), { legalHold: false });
    const call = fake.signedCalls[0];
    if (call === undefined) return expect.unreachable('no signed request was sent');
    const owned = ['authorization', 'x-amz-date', 'x-amz-content-sha256', 'host'];
    const resigned = await signAwsRequest({
      method: 'PUT',
      url: call.url,
      headers: Object.fromEntries(
        Object.entries(call.headers).filter(([name]) => !owned.includes(name)),
      ),
      payload: { body: bytesOf('x') },
      credentials: { accessKeyId: 'fake-id', secretAccessKey: 'fake-secret' },
      region: 'eu-west-1',
      service: 's3',
      clock,
    });
    expect(call.url.href).toBe('http://127.0.0.1:9000/b/org/o1/ledger.csv');
    expect(call.headers['authorization']).toBe(resigned.headers['authorization']);
    expect(call.headers['authorization']).toContain('/20261006/eu-west-1/s3/aws4_request');
    expect(call.headers['x-amz-object-lock-legal-hold']).toBe('OFF');
  });

  test('a plain put() stays on the Bun client and signs nothing', async () => {
    const { fake, driver } = disk();
    await driver.put(KEY, bytesOf('x'), { contentType: 'text/plain' });
    expect(fake.signedCalls).toHaveLength(0);
    expect(fake.store.get(KEY)?.type).toBe('text/plain');
  });

  test('an STS session token is sent and signed', async () => {
    const { fake, driver } = disk({
      sessionTokenEnv: 'S3_SESSION_TOKEN',
      env: { ...FAKE_ENV, S3_SESSION_TOKEN: 'sts-token' },
    });
    await driver.put(KEY, bytesOf('x'), { metadata: { a: 'b' } });
    const headers = fake.signedCalls[0]?.headers ?? {};
    expect(headers['x-amz-security-token']).toBe('sts-token');
    expect(headers['authorization']).toContain('x-amz-security-token');
  });

  test('forcePathStyle: false addresses the bucket as a virtual host', async () => {
    const { fake, driver } = disk({
      forcePathStyle: false,
      endpoint: 'https://acct.r2.cloudflarestorage.com',
    });
    await driver.put(KEY, bytesOf('x'), { cacheControl: 'no-store' });
    expect(fake.signedCalls[0]?.url.href).toBe(
      'https://b.acct.r2.cloudflarestorage.com/org/o1/ledger.csv',
    );
  });

  test.each([
    ['a metadata name that is not a header token', { metadata: { 'two words': 'x' } }],
    ['a non-ASCII metadata value', { metadata: { owner: 'Zoë' } }],
    ['a cacheControl with a line break', { cacheControl: 'no-store\r\nx-evil: 1' }],
    ['a retainUntil already past', { retention: { mode: 'GOVERNANCE', retainUntil: new Date(0) } }],
  ] as const)('%s is X_INVARIANT and nothing is sent', async (_label, options) => {
    const { fake, driver } = disk();
    expect(codeOf(await catchError(() => driver.put(KEY, bytesOf('x'), options)))).toBe(
      'X_INVARIANT',
    );
    expect(fake.signedCalls).toHaveLength(0);
  });

  test('a provider refusal is X_STORAGE_PUT_FAILED; a wrong region is X_CONFIG_INVALID', async () => {
    const denied = disk();
    denied.fake.failWriteWith = s3Error('AccessDenied', 403, KEY);
    const refusal = await catchError(() =>
      denied.driver.put(KEY, bytesOf('x'), { legalHold: true }),
    );
    expect(codeOf(refusal)).toBe('X_STORAGE_PUT_FAILED');
    expect(String((refusal as Error).message)).toContain('AccessDenied');

    const wrong = disk();
    wrong.fake.failWriteWith = Object.assign(s3Error('AuthorizationHeaderMalformed', 400, KEY), {
      message: `the region 'auto' is wrong; expecting 'eu-central-1'`,
    });
    const misregion = await catchError(() =>
      wrong.driver.put(KEY, bytesOf('x'), { legalHold: true }),
    );
    expect(codeOf(misregion)).toBe('X_CONFIG_INVALID');
    expect((misregion as { fix: string }).fix).toContain('S3_REGION=eu-central-1');
  });

  test('no credentials is X_ENV_MISSING, before any request', async () => {
    const { fake, driver } = disk({ env: {} });
    expect(codeOf(await catchError(() => driver.put(KEY, bytesOf('x'), { legalHold: true })))).toBe(
      'X_ENV_MISSING',
    );
    expect(fake.signedCalls).toHaveLength(0);
  });
});

describe('retentionOf()', () => {
  test('reads back the retention and the hold put() set', async () => {
    const { fake, driver } = disk();
    await driver.put(KEY, bytesOf('x'), {
      retention: { mode: 'GOVERNANCE', retainUntil },
      legalHold: true,
    });
    expect(await driver.retentionOf?.(KEY)).toEqual({
      retention: { mode: 'GOVERNANCE', retainUntil },
      legalHold: true,
    });
    const reads = fake.signedCalls.slice(1).map((call) => `${call.method} ${call.url.search}`);
    expect(reads.sort()).toEqual(['GET ?legal-hold=', 'GET ?retention=']);
  });

  test('no lock on the object, or none on the bucket, is nothing locking it', async () => {
    const { fake, driver } = disk();
    await driver.put(KEY, bytesOf('x'), { metadata: { a: 'b' } });
    expect(await driver.retentionOf?.(KEY)).toEqual({ legalHold: false });
    fake.lockDisabled = true;
    expect(await driver.retentionOf?.(KEY)).toEqual({ legalHold: false });
  });

  test('an absent object is X_STORAGE_NOT_FOUND; a denied read is X_STORAGE_READ_FAILED', async () => {
    const { fake, driver } = disk();
    expect(codeOf(await catchError(() => driver.retentionOf?.(KEY) ?? Promise.resolve()))).toBe(
      'X_STORAGE_NOT_FOUND',
    );
    await driver.put(KEY, bytesOf('x'), { legalHold: true });
    fake.failLockReadWith = s3Error('AccessDenied', 403, KEY);
    const denied = await catchError(() => driver.retentionOf?.(KEY) ?? Promise.resolve());
    expect(codeOf(denied)).toBe('X_STORAGE_READ_FAILED');
    expect((denied as { fix: string }).fix).toContain('aws s3api get-object-retention --bucket b');
  });
});
