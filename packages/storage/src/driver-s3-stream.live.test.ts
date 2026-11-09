// The large-object paths against a real server: the signed multipart upload, the ranged stream, and
// the one claim only a provider can prove, that a signed `content-length` binds a browser's PUT. A
// fake agrees with the driver by construction. Skips with no `TEST_S3_URL`; see `driver-s3.live.test.ts`.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { markListening } from '@ultimat3/core';
import type { StorageDriver } from './driver';
import { s3Driver } from './driver-s3';
import { bytesOf, catchError, codeOf, textOf } from './driver-s3-fixture';
import { targetOf, wallClock } from './driver-s3-live-fixture';
import { sendSigned } from './driver-s3-signed';
import { grantUpload } from './grant';
import { uploadPolicy } from './upload';

const target = targetOf(Bun.env['TEST_S3_URL']);
const PREFIX = `xlive-stream-${crypto.randomUUID()}`;
const at = (name: string): string => `${PREFIX}/${name}`;

/** `ListMultipartUploads` for one key: what would go on billing if an abort had not happened. */
const signedList = async (prefix: string): Promise<string> => {
  if (target === undefined) return '';
  const result = await sendSigned(
    {
      bucket: target.bucket,
      endpoint: target.endpoint,
      forcePathStyle: true,
      clock: wallClock,
      env: {
        S3_ACCESS_KEY_ID: target.accessKeyId,
        S3_SECRET_ACCESS_KEY: target.secretAccessKey,
      },
    },
    { method: 'GET', key: '', query: { uploads: '', prefix } },
  );
  return result.ok ? result.response.text() : `refused: ${result.refusal.code}`;
};

describe.skipIf(target === undefined)('live · s3 · large objects', () => {
  let disk: StorageDriver;
  let release: () => void = () => undefined;

  beforeAll(() => {
    if (target === undefined) return;
    disk = s3Driver({
      bucket: target.bucket,
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

  afterAll(async () => {
    if (target === undefined) return;
    const page = await disk.list({ prefix: `${PREFIX}/`, limit: 100 });
    for (const entry of page.rows) await disk.delete(entry.key);
    release();
  });

  test('12 MiB through putStream, then a window from its tail', async () => {
    const MIB = 1024 * 1024;
    let left = 12;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (left === 0) return controller.close();
        controller.enqueue(new Uint8Array(MIB).fill(left));
        left -= 1;
      },
    });
    const object = await disk.putStream(at('big.bin'), body, {
      maxBytes: 64 * MIB,
      contentType: 'video/mp4',
      metadata: { run: 'r-1' },
    });
    expect(object.size).toBe(12 * MIB);
    expect(object.contentType).toBe('video/mp4');
    // Two parts: 8 MiB (`STREAM_PART_BYTES`) and the 4 MiB rest.
    expect(object.etag).toEndWith('-2"');
    const tail = new Uint8Array(
      await new Response(
        await disk.streamRange(at('big.bin'), [12 * MIB - 4, 12 * MIB + 100]),
      ).arrayBuffer(),
    );
    expect([...tail]).toEqual([1, 1, 1, 1]);
    const head = new Uint8Array(
      await new Response(await disk.streamRange(at('big.bin'), [0, 1])).arrayBuffer(),
    );
    expect([...head]).toEqual([12, 12]);
    expect(
      codeOf(await catchError(() => disk.streamRange(at('big.bin'), [12 * MIB, 12 * MIB]))),
    ).toBe('X_STORAGE_RANGE_UNSATISFIABLE');
  });

  test('an overrun past one part leaves the key as it was and no upload open', async () => {
    const MIB = 1024 * 1024;
    await disk.put(at('kept.bin'), bytesOf('previous'));
    const body = new ReadableStream<Uint8Array>({
      pull: (controller) => controller.enqueue(new Uint8Array(MIB)),
    });
    expect(
      codeOf(await catchError(() => disk.putStream(at('kept.bin'), body, { maxBytes: 11 * MIB }))),
    ).toBe('X_STORAGE_TOO_LARGE');
    expect(textOf((await disk.get(at('kept.bin'))).bytes)).toBe('previous');
    const open = await signedList(at('kept.bin'));
    expect(open).toContain('ListMultipartUploadsResult');
    expect(open).not.toContain('<UploadId>');
  });

  test('a grant binds its size at the provider: any other length is refused at the PUT', async () => {
    const grant = await grantUpload({
      disk,
      orgId: 'o1',
      policy: uploadPolicy({ maxBytes: 1024, allowedContentTypes: ['image/png'] }),
      request: { filename: 'a.png', contentType: 'image/png', size: 10 },
      clock: wallClock,
    });
    // Outside the run's prefix (the key is the grant's), so the sweep in afterAll never sees it.
    try {
      const put = (body: BodyInit): Promise<Response> => fetch(grant.url, { method: 'PUT', body });
      const longer = await put(new Uint8Array(1000));
      expect(longer.status).toBe(403);
      const shorter = await put(new Uint8Array(5));
      expect(shorter.status).toBe(403);
      // No declared length at all: a chunked body is not a way around the signed header.
      const chunked = await put(new Blob([new Uint8Array(1000)]).stream());
      expect(chunked.status).toBe(403);
      expect(await disk.exists(grant.key)).toBe(false);

      const exact = await put(new Uint8Array(10));
      expect(exact.status).toBe(200);
      expect((await disk.stat(grant.key))?.size).toBe(10);
    } finally {
      await disk.delete(grant.key);
    }
  });
});
