// The browser half of an upload in parts, against a real memory disk behind the app's calls: the
// transport is injected, so a dropped part, a retry and a resume are counted, never timed.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { acceptSignedPart } from './accept-part';
import { memoryStorageDriver } from './driver-memory';
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
import type { SignedPut, UploadSource } from './upload-client';
import { uploadFile } from './upload-client';
import type { MultipartUploadClient } from './upload-client-multipart';

const SIZE = 2 * MIN_PART_BYTES + 10;
const fileOf = (size: number): UploadSource =>
  Object.assign(new Blob([new Uint8Array(size).map((_, at) => at % 249)], { type: 'video/mp4' }), {
    name: 'film.mp4',
  }) as UploadSource;

/** The app's server: one memory disk, the five calls wrapped as an app's actions would be. */
const server = () => {
  const disk = memoryStorageDriver({ signingSecret: 'test-secret', clock: frozenClock(0) });
  const policy = uploadPolicy({ maxBytes: 1 << 30, allowedContentTypes: ['video/mp4'] });
  const orgId = 'org-1';
  const calls = { grant: 0, listParts: 0, complete: 0, abort: 0 };
  const client = (extra: Partial<MultipartUploadClient> = {}): MultipartUploadClient => ({
    grant: async (request) => {
      calls.grant += 1;
      return grantMultipart({ disk, orgId, request, policy });
    },
    signPart: (input) => signPart({ disk, orgId, ...input, policy }),
    listParts: (input) => {
      calls.listParts += 1;
      return listParts({ disk, orgId, ...input });
    },
    complete: (input) => {
      calls.complete += 1;
      return completeUpload({ disk, orgId, ...input, policy });
    },
    abort: (input) => {
      calls.abort += 1;
      return abortUpload({ disk, orgId, ...input });
    },
    partThresholdBytes: MIN_PART_BYTES,
    sleep: async () => undefined,
    ...extra,
  });
  /** The `/_storage` PUT, minus HTTP: what a part request reaches on a local disk. */
  const sent: number[] = [];
  const put: SignedPut = async ({ url, body }) => {
    sent.push(Number(new URL(url, 'http://app.test').searchParams.get('x-part')));
    await acceptSignedPart({ url, disk, orgId, bytes: new Uint8Array(await body.arrayBuffer()) });
  };
  return { disk, client, calls, put, sent };
};

describe('uploadFile in parts', () => {
  test('above the threshold the file goes up in parts and lands whole', async () => {
    const { disk, client, put, sent } = server();
    const progress: number[] = [];
    const result = await uploadFile({
      file: fileOf(SIZE),
      grant: async () => expect.unreachable('a file over the threshold never asks for one PUT'),
      multipart: client(),
      put,
      onProgress: ({ loaded }) => progress.push(loaded),
    });
    expect(sent.sort()).toEqual([1, 2, 3]);
    expect(result.size).toBe(SIZE);
    const stored = new Uint8Array(await new Response(await disk.stream(result.key)).arrayBuffer());
    expect(stored).toEqual(new Uint8Array(await fileOf(SIZE).arrayBuffer()));
    expect(progress.at(-1)).toBe(SIZE);
  });

  test('a part failing twice then landing is retried, and only that part', async () => {
    const { client, put, sent } = server();
    let failures = 0;
    const flaky: SignedPut = async (input) => {
      if (input.url.includes('x-part=2') && failures < 2) {
        failures += 1;
        sent.push(-2);
        throw uploadFailed('/_storage/memory/x', 0, 'the request never reached the disk');
      }
      await put(input);
    };
    const result = await uploadFile({
      file: fileOf(SIZE),
      grant: async () => expect.unreachable('parts, not one PUT'),
      multipart: client(),
      put: flaky,
    });
    expect(result.size).toBe(SIZE);
    expect(sent.filter((n) => n === -2).length).toBe(2);
    expect(sent.filter((n) => n > 0).sort()).toEqual([1, 2, 3]);
  });

  test('a resume lists what landed and sends only the missing parts', async () => {
    const { client, calls, put, sent } = server();
    let grant: MultipartGrant | undefined;
    const dropsThree: SignedPut = async (input) => {
      if (input.url.includes('x-part=3')) {
        throw uploadFailed('/_storage/memory/x', 503, 'the connection dropped');
      }
      await put(input);
    };
    const first = await uploadFile({
      file: fileOf(SIZE),
      grant: async () => expect.unreachable('parts, not one PUT'),
      multipart: client({ onGrant: (granted) => (grant = granted) }),
      put: dropsThree,
    }).catch((error: unknown) => error);
    expect(first).toBeUltimateError('X_STORAGE_UPLOAD_FAILED');
    expect(grant).toBeDefined();
    sent.length = 0;

    const resumed = await uploadFile({
      file: fileOf(SIZE),
      grant: async () => expect.unreachable('parts, not one PUT'),
      multipart: client({ resume: grant }),
      put,
    });
    expect(sent).toEqual([3]);
    expect(calls).toMatchObject({ grant: 1, listParts: 1, complete: 1, abort: 0 });
    expect(resumed.key).toBe(grant?.key ?? 'no grant');
  });

  test('a cancelled upload aborts its session, so no part is left billing', async () => {
    const { disk, client, calls, put } = server();
    const controller = new AbortController();
    const cancelsAfterOne: SignedPut = async (input) => {
      await put(input);
      controller.abort();
    };
    const outcome = await uploadFile({
      file: fileOf(SIZE),
      grant: async () => expect.unreachable('parts, not one PUT'),
      multipart: client(),
      put: cancelsAfterOne,
      signal: controller.signal,
    }).catch((error: unknown) => error);
    expect(outcome).toBeUltimateError('X_STORAGE_UPLOAD_FAILED');
    expect(calls.abort).toBe(1);
    expect(await disk.multipart?.listUploads()).toEqual([]);
  });

  test('a large file with no multipart form takes one PUT, as before', async () => {
    const { client } = server();
    const urls: string[] = [];
    await uploadFile({
      file: fileOf(SIZE),
      grant: async (request) => ({
        key: 'org/org-1/pending/u.mp4',
        url: '/_storage/memory/org/org-1/pending/u.mp4?x-sig=1',
        method: 'PUT',
        contentType: request.contentType,
        maxBytes: request.size,
        expiresAt: 0,
      }),
      put: async ({ url }) => {
        urls.push(url);
      },
    });
    expect(urls.length).toBe(1);
    // And at or under the threshold, the multipart form still takes the one PUT.
    let parts = 0;
    await uploadFile({
      file: fileOf(MIN_PART_BYTES),
      grant: async (request) => ({
        key: 'k',
        url: '/u',
        method: 'PUT',
        contentType: request.contentType,
        maxBytes: request.size,
        expiresAt: 0,
      }),
      multipart: client({ grant: async () => expect.unreachable('under the threshold') }),
      put: async () => {
        parts += 1;
      },
    });
    expect(parts).toBe(1);
  });
});
