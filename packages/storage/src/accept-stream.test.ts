// The streamed accept: the same gates as `acceptSignedUpload`, judged on a head, and every refusal
// that arrives after the head — a declared checksum the bytes do not hash to, a body past the
// ceiling — leaves the key as it was.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API and no recursive remove; the local disk needs a real root.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no `tmpdir()`; `node:os` is the only way to ask the platform for it.
import { tmpdir } from 'node:os';
import { frozenClock } from '@ultimat3/core';
import { acceptSignedUploadStream } from './accept-stream';
import type { StorageDriver } from './driver';
import { sha256Base64 } from './driver';
import { localDriver } from './driver-local';
import { grantUpload } from './grant';
import { SNIFF_WINDOW_BYTES, uploadPolicy } from './upload';

const SECRET = 'test-signing-secret';
const ORG = 'org-1';
const clock = frozenClock('2026-07-26T12:00:00.000Z');
const MAX = 4 * SNIFF_WINDOW_BYTES;

let root = '';
let disk: StorageDriver;

beforeEach(async () => {
  root = await mkdtemp(`${tmpdir()}/ultimate-accept-stream-`);
  disk = localDriver({ root, signingSecret: SECRET, clock });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const PDF_HEAD = new TextEncoder().encode('%PDF-1.7\n%âãÏÓ\n');

/** A PDF of `size` bytes, 4 KiB per chunk. */
const pdf = (size: number): Uint8Array => {
  const bytes = new Uint8Array(size).fill(0x20);
  bytes.set(PDF_HEAD);
  return bytes;
};
const streamOf = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (let at = 0; at < bytes.byteLength; at += 4096) {
        controller.enqueue(bytes.slice(at, at + 4096));
      }
      controller.close();
    },
  });

const accept = async (
  contentType: string,
  body: Uint8Array,
  extra: { readonly checksum?: string; readonly maxBytes?: number } = {},
) => {
  const policy = uploadPolicy({ maxBytes: MAX, allowedContentTypes: [contentType] });
  const grant = await grantUpload({
    disk,
    orgId: ORG,
    policy,
    clock,
    request: { filename: 'a.bin', contentType, size: extra.maxBytes ?? MAX },
  });
  const stored = acceptSignedUploadStream({
    url: grant.url,
    disk,
    orgId: ORG,
    body: streamOf(body),
    declaredContentType: contentType,
    policy,
    clock,
    ...(extra.checksum === undefined ? {} : { checksum: extra.checksum }),
  });
  return { grant, stored };
};

describe('acceptSignedUploadStream', () => {
  test('a body past the sniff window streams to the disk, byte for byte', async () => {
    const bytes = pdf(3 * SNIFF_WINDOW_BYTES + 17);
    const { grant, stored } = await accept('application/pdf', bytes);
    expect((await stored).size).toBe(bytes.byteLength);
    expect((await disk.get(grant.key)).bytes).toEqual(bytes);
  });

  test('a declared checksum the bytes match is accepted; one they do not stores nothing', async () => {
    const bytes = pdf(2 * SNIFF_WINDOW_BYTES);
    const good = await accept('application/pdf', bytes, { checksum: sha256Base64(bytes) });
    expect((await good.stored).size).toBe(bytes.byteLength);
    const bad = await accept('application/pdf', bytes, { checksum: sha256Base64(pdf(64)) });
    await expect(bad.stored).rejects.toBeUltimateError('X_STORAGE_CHECKSUM_MISMATCH');
    expect(await disk.exists(bad.grant.key)).toBe(false);
  });

  test('past the signed ceiling, nothing is stored', async () => {
    const { grant, stored } = await accept('application/pdf', pdf(MAX + 1));
    await expect(stored).rejects.toBeUltimateError('X_STORAGE_TOO_LARGE');
    expect(await disk.exists(grant.key)).toBe(false);
  });

  test('an XML type past the window is read whole: judged as a document, never refused as a head', async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">${'<g/>'.repeat(SNIFF_WINDOW_BYTES / 2)}</svg>`;
    const { stored } = await accept('image/svg+xml', new TextEncoder().encode(svg));
    expect((await stored).contentType).toBe('image/svg+xml');
  });

  test('a head that is not the signed type stores nothing', async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">${'<g/>'.repeat(SNIFF_WINDOW_BYTES / 2)}</svg>`;
    const { grant, stored } = await accept('application/pdf', new TextEncoder().encode(svg));
    await expect(stored).rejects.toBeUltimateError('X_STORAGE_TYPE_REJECTED');
    expect(await disk.exists(grant.key)).toBe(false);
  });

  test('a text body opening with markup is read whole: XHTML past the window is still refused', async () => {
    // Under text/plain a browser sniffs nothing, but `validateUpload` refuses markup a browser RUNS
    // anywhere in the body; judged on a 64 KiB head, this one passed.
    const page = `<a>${' '.repeat(SNIFF_WINDOW_BYTES + 16)}<html xmlns="http://www.w3.org/1999/xhtml"><script>alert(document.cookie)</script></html></a>`;
    for (const type of ['text/plain', 'text/csv', 'application/json']) {
      const { grant, stored } = await accept(type, new TextEncoder().encode(page));
      await expect(stored).rejects.toBeUltimateError('X_STORAGE_TYPE_REJECTED');
      expect(await disk.exists(grant.key)).toBe(false);
    }
  });

  test('a grant smaller than the sniff window is held to it while the head is read', async () => {
    const { grant, stored } = await accept('application/pdf', pdf(SNIFF_WINDOW_BYTES), {
      maxBytes: 4096,
    });
    await expect(stored).rejects.toBeUltimateError('X_STORAGE_TOO_LARGE');
    expect(await disk.exists(grant.key)).toBe(false);
  });

  test('a disk that gives up part-way cancels the uploader’s body: no socket read to the end', async () => {
    const policy = uploadPolicy({ maxBytes: MAX, allowedContentTypes: ['application/pdf'] });
    const request = { filename: 'a.pdf', contentType: 'application/pdf', size: MAX };
    const grant = await grantUpload({ disk, orgId: ORG, policy, clock, request });
    let cancelled = false;
    const bytes = pdf(MAX);
    let at = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(bytes.slice(at, at + 4096));
        at += 4096;
      },
      cancel: () => {
        cancelled = true;
      },
    });
    const quitting: StorageDriver = {
      ...disk,
      async putStream(_key, stream) {
        const reader = stream.getReader();
        await reader.read();
        await reader.cancel('the disk gave up');
        return expect.unreachable('a disk that gave up returns nothing');
      },
    };
    await acceptSignedUploadStream({
      url: grant.url,
      disk: quitting,
      orgId: ORG,
      body,
      declaredContentType: 'application/pdf',
      policy,
      clock,
    }).catch(() => undefined);
    expect(cancelled).toBe(true);
    expect(at).toBeLessThan(MAX);
  });
});
