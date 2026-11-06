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

  test("AWS's published query-signing example, byte for byte", async () => {
    // "Authenticating Requests: Using Query Parameters (AWS Signature Version 4)", the S3 API
    // reference's worked GET of `test.txt`: its canonical request, string to sign and signature.
    const signed = await presignAwsUrl({
      credentials: {
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      },
      region: 'us-east-1',
      service: 's3',
      method: 'GET',
      url: 'https://examplebucket.s3.amazonaws.com/test.txt',
      expiresInSeconds: 86_400,
      clock: frozenClock('2013-05-24T00:00:00.000Z'),
    });
    expect(signed.canonicalRequest).toBe(
      [
        'GET',
        '/test.txt',
        'X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host',
        'host:examplebucket.s3.amazonaws.com',
        '',
        'host',
        'UNSIGNED-PAYLOAD',
      ].join('\n'),
    );
    expect(signed.stringToSign).toBe(
      [
        'AWS4-HMAC-SHA256',
        '20130524T000000Z',
        '20130524/us-east-1/s3/aws4_request',
        '3bfa292879f6447bbcda7001decf97f4a54dc650c8942174ae0a9121cf58ad04',
      ].join('\n'),
    );
    expect(signed.signature).toBe(
      'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    );
  });

  test("a part's partNumber and uploadId stay in the URL, inside the signature", async () => {
    // What Bun's presign cannot do: it drops a query it is handed. A part URL that lost either
    // would be a PUT of the whole object, so both are signed and both survive into the URL.
    const part = (partNumber: string) =>
      presignAwsUrl({
        ...S3,
        method: 'PUT',
        url: `${OBJECT_URL}?partNumber=${partNumber}&uploadId=up%2F1`,
        expiresInSeconds: 60,
        headers: { 'content-length': String(5 * 1024 * 1024) },
        clock,
      });
    const first = await part('1');
    const query = new URL(first.url).searchParams;
    expect(query.get('partNumber')).toBe('1');
    expect(query.get('uploadId')).toBe('up/1');
    expect(first.canonicalRequest.split('\n')[2]).toContain('&partNumber=1&uploadId=up%2F1');
    expect((await part('2')).signature).not.toBe(first.signature);
  });

  test('an expiry S3 could never honour is refused where it is written', async () => {
    for (const expiresInSeconds of [0, -1, 1.5, Number.NaN, 604_801]) {
      await expect(
        presignAwsUrl({ ...S3, method: 'GET', url: OBJECT_URL, expiresInSeconds, clock }),
      ).rejects.toBeUltimateError('X_INVARIANT');
    }
  });
});
