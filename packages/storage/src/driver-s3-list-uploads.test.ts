// ListMultipartUploads on the signed wire, every page, whatever the key's length: S3 keys run to
// 1,024 bytes and `assertSafeKey` admits them, so a session the listing drops is one
// `abortStaleUploads` never reclaims, and its parts bill until someone finds them by hand.

import { describe, expect, test } from 'bun:test';
import { FAKE_ENV } from './driver-s3-fixture';
import { listS3Uploads } from './driver-s3-multipart';
import type { S3FetchLike, S3Refusal } from './driver-s3-signed';

/** A key S3 escapes to longer than the old 512-character read: `&` is `&amp;` on the wire. */
const LONG_KEY = `org/org-1/pending/${'a&b-'.repeat(150)}.bin`;
const escaped = (text: string): string => text.replaceAll('&', '&amp;');

const page = (key: string, uploadId: string, next: string | undefined): string =>
  [
    '<ListMultipartUploadsResult>',
    `<IsTruncated>${next === undefined ? 'false' : 'true'}</IsTruncated>`,
    next === undefined ? '' : `<NextKeyMarker>${escaped(next)}</NextKeyMarker>`,
    next === undefined ? '' : `<NextUploadIdMarker>${uploadId}</NextUploadIdMarker>`,
    `<Upload><Key>${escaped(key)}</Key><UploadId>${uploadId}</UploadId>`,
    '<Initiated>2026-07-26T12:00:00.000Z</Initiated></Upload>',
    '</ListMultipartUploadsResult>',
  ].join('');

describe('listS3Uploads', () => {
  test('a key past 512 characters is listed, and its marker pages on', async () => {
    expect(escaped(LONG_KEY).length).toBeGreaterThan(512);
    const asked: string[] = [];
    const fetch: S3FetchLike = async (url) => {
      asked.push(url);
      const marker = new URL(url).searchParams.get('key-marker');
      const body =
        marker === null
          ? page(LONG_KEY, 'u-1', LONG_KEY)
          : page('org/org-1/b.bin', 'u-2', undefined);
      return new Response(body, { status: 200 });
    };
    const refused = (refusal: S3Refusal): never => {
      throw expect.unreachable(`refused: ${refusal.code}`);
    };
    const sessions = await listS3Uploads(
      { wire: { bucket: 'b', env: FAKE_ENV, fetch }, refused },
      'org/org-1/',
    );
    expect(sessions.map((session) => [session.key, session.uploadId])).toEqual([
      [LONG_KEY, 'u-1'],
      ['org/org-1/b.bin', 'u-2'],
    ]);
    expect(asked.length).toBe(2);
    expect(new URL(asked[1] ?? '').searchParams.get('key-marker')).toBe(LONG_KEY);
  });
});
