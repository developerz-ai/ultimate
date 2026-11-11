/**
 * unit — the avatar round trip against a real local disk, with no database and no network.
 *
 * The three things worth pinning: the key is DERIVED (the client contributes an extension and
 * nothing else), the refusals happen before a URL exists, and what the read half hands back is a
 * capability that verifies against the disk's own secret — not just a string containing a key.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// `mkdtemp`/`rm` are `node:`-only by necessity: Bun exposes no temp-directory primitive, and a
// disk rooted inside the repo would survive a failed run. Same shape as the framework's own
// `driver-local.test.ts`.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { memberId as toMemberId, orgId as toOrgId } from '@postly/domain';
import type { Page } from '@ultimat3/core';
import { blankRaster, encodeImage, frozenClock, pageOf } from '@ultimat3/core';
import type { ListOptions, StorageDriver, StorageListEntry } from '@ultimat3/storage';
import {
  attachmentKey,
  defineStorage,
  disk,
  isStorageError,
  localDriver,
  resetStorage,
  variantSourceOf,
  verifySignedUrl,
} from '@ultimat3/storage';
import {
  AVATAR_RENDER_WIDTH,
  AVATAR_URL_TTL_MS,
  avatarTarget,
  avatarUploadPolicy,
  mintAvatarGrant,
  signedAvatarUrl,
} from './avatar';

const ORG = toOrgId('3f1b7f4a-5c2d-4a5b-9f6e-0a1b2c3d4e5f');
const MEMBER = toMemberId('7c9e6679-7425-40de-944b-e07fc1f90ae7');
const OTHER = toMemberId('1e3f5a70-9b2c-4d8e-8a1f-2b3c4d5e6f70');

const SECRET = 'avatar-test-secret';
const BASE_URL = '/_storage/local';
const NOW = '2026-08-14T09:00:00.000Z';

const clock = frozenClock(NOW);
const request = { filename: 'holiday-snap.PNG', contentType: 'image/png', size: 1024 };

let root = '';

beforeEach(async () => {
  root = await mkdtemp(`${tmpdir()}/postly-avatar-`);
  resetStorage();
  defineStorage({
    disks: { local: localDriver({ root, signingSecret: SECRET, baseUrl: BASE_URL, clock }) },
    default: 'local',
  });
});

afterEach(async () => {
  resetStorage();
  await rm(root, { recursive: true, force: true });
});

/** A real image: the read half resizes what it hands out, so the bytes must decode. */
const png = (side: number): Uint8Array => encodeImage(blankRaster(side, side));

/** What the browser does with a grant, minus the browser; `side` tells two uploads apart. */
const put = (key: string, side = 8): Promise<unknown> =>
  disk().put(key, png(side), { contentType: 'image/png' });

const codeOf = async (call: Promise<unknown>): Promise<string | undefined> => {
  try {
    await call;
    return undefined;
  } catch (error) {
    return isStorageError(error) ? error.code : undefined;
  }
};

describe('the upload grant', () => {
  test('derives a pending key in the org and keeps only the extension', async () => {
    const grant = await mintAvatarGrant({ orgId: ORG, memberId: MEMBER, request, clock });

    // `pending/`, never the member's prefix: the app's scanner refuses a targeted grant, and
    // `attachAvatar` is the step that scans it onto the avatar prefix.
    expect(grant.key.startsWith(`org/${ORG}/pending/`)).toBe(true);
    expect(grant.key.endsWith('.png')).toBe(true);
    // The filename survives as a lower-cased extension and in no other form.
    expect(grant.key).not.toContain('holiday');
    expect(grant.method).toBe('PUT');
    expect(grant.maxBytes).toBe(request.size);
    expect(grant.expiresAt).toBeGreaterThan(clock.now().getTime());
  });

  test('signs the constraints it just refused to widen', async () => {
    const grant = await mintAvatarGrant({ orgId: ORG, memberId: MEMBER, request, clock });
    const verified = await verifySignedUrl({
      url: grant.url,
      secret: SECRET,
      baseUrl: BASE_URL,
      clock,
    });

    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.constraints.key).toBe(grant.key);
    expect(verified.constraints.method).toBe('PUT');
    expect(verified.constraints.maxBytes).toBe(request.size);
    expect(verified.constraints.contentType).toBe('image/png');
  });

  test('refuses an SVG and an over-size upload before any URL exists', async () => {
    const svg = { ...request, filename: 'me.svg', contentType: 'image/svg+xml' };
    expect(
      await codeOf(mintAvatarGrant({ orgId: ORG, memberId: MEMBER, request: svg, clock })),
    ).toBe('X_STORAGE_TYPE_REJECTED');

    const huge = { ...request, size: avatarUploadPolicy.maxBytes + 1 };
    expect(
      await codeOf(mintAvatarGrant({ orgId: ORG, memberId: MEMBER, request: huge, clock })),
    ).toBe('X_STORAGE_TOO_LARGE');

    expect((await disk().list({ prefix: `org/${ORG}/` })).rows).toEqual([]);
  });
});

describe('the rendered avatar', () => {
  test('is null until the member has uploaded one', async () => {
    expect(await signedAvatarUrl(ORG, MEMBER)).toBeNull();
  });

  test('hands out the stored resize of the current avatar, never the upload itself', async () => {
    const original = attachmentKey(ORG, avatarTarget(MEMBER), 'me.png');
    await put(original, 400);

    const url = await signedAvatarUrl(ORG, MEMBER);
    expect(url).not.toBeNull();
    const verified = await verifySignedUrl({
      url: url ?? '',
      secret: SECRET,
      baseUrl: BASE_URL,
      clock,
    });

    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    const signed = verified.constraints.key;
    expect(variantSourceOf(signed)?.source).toBe(original);
    expect(signed).toContain(`@w${AVATAR_RENDER_WIDTH}`);
    expect(signed.endsWith('.webp')).toBe(true);
    expect(verified.constraints.method).toBe('GET');
    expect(verified.constraints.expiresAt).toBe(clock.now().getTime() + AVATAR_URL_TTL_MS);
    // Kept, so the next render is a `stat`: `variant()` wrote it once, under the key it signed.
    expect((await disk().stat(signed))?.contentType).toBe('image/webp');
  });

  test('a resized copy beside the avatar is never mistaken for the current avatar', async () => {
    const original = attachmentKey(ORG, avatarTarget(MEMBER), 'a-first.png');
    await put(original);
    // Sorts after the original and is newer: picked as "the last upload" if copies counted.
    await put(`${original}@w96-r0123abcd.png`);

    const signed = decodeURIComponent((await signedAvatarUrl(ORG, MEMBER)) ?? '');
    expect(signed).toContain(`a-first.png@w${AVATAR_RENDER_WIDTH}`);
  });

  test('is the last upload even when it lands past the first page of the listing', async () => {
    const target = avatarTarget(MEMBER);
    await put(attachmentKey(ORG, target, 'a-first.png'), 8);
    await put(attachmentKey(ORG, target, 'b-second.png'), 9);

    // One object per page — S3's own shape at 1000 keys, made cheap. A single `list` call sees
    // only `a-first.png`, so the read half must follow the cursor to find the current avatar.
    const inner = disk();
    const paged: StorageDriver = {
      ...inner,
      async list(options?: ListOptions): Promise<Page<StorageListEntry>> {
        const all = await inner.list({ ...options, cursor: null });
        const from = typeof options?.cursor === 'string' ? Number(options.cursor) : 0;
        const next = from + 1;
        return pageOf(all.rows.slice(from, next), next < all.rows.length ? String(next) : null);
      },
    };
    resetStorage();
    defineStorage({ disks: { local: paged }, default: 'local' });

    expect((await signedAvatarUrl(ORG, MEMBER)) ?? '').toContain('b-second.png');
  });

  test('a disk that reports no dates still answers one avatar — the key decides', async () => {
    const target = avatarTarget(MEMBER);
    await put(attachmentKey(ORG, target, 'a-first.png'), 8);
    await put(attachmentKey(ORG, target, 'b-second.png'), 9);

    // A provider whose listing carries no LastModified: the entries have no date at all.
    const inner = disk();
    const undated: StorageDriver = {
      ...inner,
      async list(options?: ListOptions): Promise<Page<StorageListEntry>> {
        const page = await inner.list(options);
        return pageOf(
          page.rows.map(({ lastModified: _unreported, ...entry }) => entry),
          page.nextCursor,
        );
      },
    };
    resetStorage();
    defineStorage({ disks: { local: undated }, default: 'local' });

    expect((await signedAvatarUrl(ORG, MEMBER)) ?? '').toContain('b-second.png');
  });

  test('is the last upload, and never another member’s', async () => {
    const target = avatarTarget(MEMBER);
    // Written in ascending key order so the assertion holds whatever the disk reports for
    // `lastModified` — a local disk's file times can tie inside one millisecond.
    await put(attachmentKey(ORG, target, 'a-first.png'), 8);
    await put(attachmentKey(ORG, target, 'b-second.png'), 9);
    await put(attachmentKey(ORG, avatarTarget(OTHER), 'c-theirs.png'), 10);

    const url = (await signedAvatarUrl(ORG, MEMBER)) ?? '';
    expect(url).toContain('b-second.png');
    expect(url).not.toContain('c-theirs.png');

    const theirs = (await signedAvatarUrl(ORG, OTHER)) ?? '';
    expect(theirs).toContain('c-theirs.png');
  });
});
