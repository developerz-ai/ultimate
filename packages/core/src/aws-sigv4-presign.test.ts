// `presignAwsUrl` held to an implementation it shares no code with: `Bun.S3Client`'s native presign
// answers the same host-only URL byte for byte, on Bun's own date. The content-length case is what
// the signer exists for and Bun has no option for, and a live server proves it in
// `packages/storage/src/driver-s3.live.test.ts`.

import { describe, expect, test } from 'bun:test';
import { presignAwsUrl } from './aws-sigv4';
import { frozenClock } from './clock';

const credentials = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
};
const S3 = { credentials, region: 'us-east-1', service: 's3' } as const;
const clock = frozenClock('2026-07-26T12:00:00.000Z');
const OBJECT_URL = 'https://s3.example.test/bucket/org/a%20b.png';

describe('presignAwsUrl', () => {
  test('answers what Bun.S3Client answers for a URL that signs host alone', async () => {
    const client = new Bun.S3Client({
      ...credentials,
      bucket: 'bucket',
      region: 'us-east-1',
      endpoint: 'https://s3.example.test',
    });
    const theirs = new URL(client.file('org/a b.png').presign({ method: 'PUT', expiresIn: 900 }));
    const date = theirs.searchParams.get('X-Amz-Date') ?? '';
    const iso = date.replace(
      /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
      '$1-$2-$3T$4:$5:$6Z',
    );
    const ours = await presignAwsUrl({
      ...S3,
      method: 'PUT',
      url: OBJECT_URL,
      expiresInSeconds: 900,
      clock: frozenClock(iso),
    });
    const parsed = new URL(ours.url);
    expect(parsed.pathname).toBe(theirs.pathname);
    expect(ours.signature).toBe(theirs.searchParams.get('X-Amz-Signature') ?? 'bun signed nothing');
    expect(Object.fromEntries(parsed.searchParams)).toEqual(
      Object.fromEntries(theirs.searchParams),
    );
  });

  test('a header handed over is signed, and named in the URL', async () => {
    const signed = await presignAwsUrl({
      ...S3,
      method: 'PUT',
      url: OBJECT_URL,
      expiresInSeconds: 60,
      headers: { 'Content-Length': '10' },
      clock,
    });
    expect(new URL(signed.url).searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;host');
    expect(signed.canonicalRequest).toContain('content-length:10\nhost:s3.example.test\n');
    expect(signed.canonicalRequest.endsWith('UNSIGNED-PAYLOAD')).toBe(true);
    const other = await presignAwsUrl({
      ...S3,
      method: 'PUT',
      url: OBJECT_URL,
      expiresInSeconds: 60,
      headers: { 'content-length': '11' },
      clock,
    });
    expect(other.signature).not.toBe(signed.signature);
  });

  test('a session token travels in the query, inside the signature', async () => {
    const signed = await presignAwsUrl({
      ...S3,
      credentials: { ...credentials, sessionToken: 'tok/en' },
      method: 'GET',
      url: OBJECT_URL,
      expiresInSeconds: 60,
      clock,
    });
    expect(new URL(signed.url).searchParams.get('X-Amz-Security-Token')).toBe('tok/en');
    expect(signed.canonicalRequest).toContain('X-Amz-Security-Token=tok%2Fen');
  });

  test('an expiry S3 could never honour is refused where it is written', async () => {
    for (const expiresInSeconds of [0, -1, 1.5, Number.NaN, 604_801]) {
      await expect(
        presignAwsUrl({ ...S3, method: 'GET', url: OBJECT_URL, expiresInSeconds, clock }),
      ).rejects.toBeUltimateError('X_INVARIANT');
    }
  });
});
