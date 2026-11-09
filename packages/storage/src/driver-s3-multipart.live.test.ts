// An upload in parts against a real S3 server: three parts presigned by core's signer, each PUT
// straight to the bucket, a run killed after two and resumed — which must resend fewer than all.
// Skips unless `TEST_S3_URL` is set; see `driver-s3.live.test.ts` for the service.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { markListening } from '@ultimat3/core';
import type { StorageDriver } from './driver';
import { s3Driver } from './driver-s3';
import { targetOf, wallClock } from './driver-s3-live-fixture';
import { uploadFailed } from './errors';
import {
  abortUpload,
  completeUpload,
  grantMultipart,
  listParts,
  type MultipartGrant,
  signPart,
} from './grant-multipart';
import { MIN_PART_BYTES } from './multipart';
import { uploadPolicy } from './upload';
import { type SignedPut, type UploadSource, uploadFile } from './upload-client';
import type { MultipartUploadClient } from './upload-client-multipart';

const target = targetOf(Bun.env['TEST_S3_URL']);
/** One tenant per run: its prefix is what the clean-up walks. */
const orgId = `xlive-${crypto.randomUUID()}`;
const SIZE = 12 * 1024 * 1024;
const policy = uploadPolicy({ maxBytes: SIZE, allowedContentTypes: ['video/mp4'] });

describe.skipIf(target === undefined)('live · s3 · an upload in parts', () => {
  let disk: StorageDriver;
  let release: () => void = () => undefined;

  beforeAll(() => {
    if (target === undefined) return;
    disk = s3Driver({
      bucket: target.bucket,
      endpoint: target.endpoint,
      forcePathStyle: true,
      env: { S3_ACCESS_KEY_ID: target.accessKeyId, S3_SECRET_ACCESS_KEY: target.secretAccessKey },
      clock: wallClock,
    });
    release = markListening(target.endpoint);
  });

  afterAll(async () => {
    if (target === undefined) return;
    for (const session of (await disk.multipart?.listUploads(`org/${orgId}/`)) ?? []) {
      await disk.multipart?.abort(session.key, session.uploadId);
    }
    const page = await disk.list({ prefix: `org/${orgId}/` });
    for (const entry of page.rows) await disk.delete(entry.key);
    release();
  });

  const client = (extra: Partial<MultipartUploadClient> = {}): MultipartUploadClient => ({
    grant: (request) => grantMultipart({ disk, orgId, request, policy, clock: wallClock }),
    signPart: (input) => signPart({ disk, orgId, ...input, policy }),
    listParts: (input) => listParts({ disk, orgId, ...input }),
    complete: (input) => completeUpload({ disk, orgId, ...input, policy }),
    abort: (input) => abortUpload({ disk, orgId, ...input }),
    partThresholdBytes: MIN_PART_BYTES,
    sleep: async () => undefined,
    ...extra,
  });
  const sent: number[] = [];
  /** A browser's PUT: the signed `content-length` is the body's own. */
  const put: SignedPut = async ({ url, body }) => {
    sent.push(Number(new URL(url).searchParams.get('partNumber')));
    const response = await fetch(url, { method: 'PUT', body });
    if (!response.ok)
      throw uploadFailed(new URL(url).pathname, response.status, await response.text());
  };

  test('a 12 MiB file in three parts, killed after two and resumed, lands whole', async () => {
    const bytes = new Uint8Array(SIZE).map((_, at) => (at * 7) % 256);
    const file = Object.assign(new Blob([bytes], { type: 'video/mp4' }), {
      name: 'film.mp4',
    }) as UploadSource;
    let grant: MultipartGrant | undefined;
    const killedAtThree: SignedPut = async (input) => {
      if (new URL(input.url).searchParams.get('partNumber') === '3') {
        throw uploadFailed('/killed', 0, 'the tab was closed');
      }
      await put(input);
    };
    const first = await uploadFile({
      file,
      grant: async () => expect.unreachable('parts, not one PUT'),
      multipart: client({ onGrant: (granted) => (grant = granted) }),
      put: killedAtThree,
    }).catch((error: unknown) => error);
    expect(first).toBeUltimateError('X_STORAGE_UPLOAD_FAILED');
    expect(grant?.maxParts).toBe(3);

    sent.length = 0;
    const done = await uploadFile({
      file,
      grant: async () => expect.unreachable('parts, not one PUT'),
      multipart: client({ resume: grant }),
      put,
    });
    expect(sent).toEqual([3]);
    const stored = await disk.stat(done.key);
    expect(stored?.size).toBe(SIZE);
    const back = new Uint8Array(await new Response(await disk.stream(done.key)).arrayBuffer());
    expect(Bun.hash(back)).toBe(Bun.hash(bytes));
    expect(await disk.multipart?.listUploads(`org/${orgId}/`)).toEqual([]);
  });

  test('a part URL lands exactly its signed length, and an abort leaves the session gone', async () => {
    const grant = await grantMultipart({
      disk,
      orgId,
      request: { filename: 'b.mp4', contentType: 'video/mp4', size: SIZE },
      policy,
      clock: wallClock,
    });
    const session = { disk, orgId, key: grant.key, uploadId: grant.uploadId };
    const url = await signPart({ ...session, policy, partNumber: 1, size: 10 });
    const short = await fetch(url, { method: 'PUT', body: new Uint8Array(9) });
    expect(short.status).toBe(403);
    expect((await fetch(url, { method: 'PUT', body: new Uint8Array(10) })).status).toBe(200);
    expect((await listParts(session)).map((part) => part.size)).toEqual([10]);
    await abortUpload(session);
    const gone = await listParts(session).catch((error: unknown) => error);
    expect(gone).toBeUltimateError('X_STORAGE_UPLOAD_UNKNOWN');
  });
});
