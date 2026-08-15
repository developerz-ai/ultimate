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
import { frozenClock } from '@ultimat3/core';
import type { ListOptions, ListPage, StorageDriver } from '@ultimat3/storage';
import {
  attachmentKey,
  defineStorage,
  disk,
  isStorageError,
  localDriver,
  resetStorage,
  verifySignedUrl,
} from '@ultimat3/storage';
import {
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
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
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

/** What the browser does with a grant, minus the browser. */
const put = (key: string, body: string): Promise<unknown> =>
  disk().put(key, bytes(body), { contentType: 'image/png' });

const codeOf = async (call: Promise<unknown>): Promise<string | undefined> => {
  try {
    await call;
    return undefined;
  } catch (error) {
    return isStorageError(error) ? error.code : undefined;
  }
};

describe('the upload grant', () => {
  test('derives a key under the member’s own prefix and keeps only the extension', async () => {
    const grant = await mintAvatarGrant({ orgId: ORG, memberId: MEMBER, request, clock });

    expect(grant.key.startsWith(`org/${ORG}/member/${MEMBER}/avatar/`)).toBe(true);
    expect(grant.key.endsWith('.png')).toBe(true);
    // The filename survives as a lower-cased extension and in no other form.
    expect(grant.key).not.toContain('holiday');
    expect(grant.method).toBe('PUT');
    expect(grant.maxBytes).toBe(avatarUploadPolicy.maxBytes);
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
    expect(verified.constraints.maxBytes).toBe(avatarUploadPolicy.maxBytes);
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

    expect((await disk().list({ prefix: `org/${ORG}/` })).objects).toEqual([]);
  });
});

describe('the rendered avatar', () => {
  test('is null until the member has uploaded one', async () => {
    expect(await signedAvatarUrl(ORG, MEMBER)).toBeNull();
  });

  test('round-trips: the granted key is the key the read half signs', async () => {
    const grant = await mintAvatarGrant({ orgId: ORG, memberId: MEMBER, request, clock });
    await put(grant.key, 'pretend-png');

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
    expect(verified.constraints.key).toBe(grant.key);
    expect(verified.constraints.method).toBe('GET');
    expect(verified.constraints.expiresAt).toBe(clock.now().getTime() + AVATAR_URL_TTL_MS);
    expect(new TextDecoder().decode((await disk().get(grant.key)).bytes)).toBe('pretend-png');
  });

  test('is the last upload even when it lands past the first page of the listing', async () => {
    const target = avatarTarget(MEMBER);
    await put(attachmentKey(ORG, target, 'a-first.png'), 'old');
    await put(attachmentKey(ORG, target, 'b-second.png'), 'new');

    // One object per page — S3's own shape at 1000 keys, made cheap. A single `list` call sees
    // only `a-first.png`, so the read half must follow the cursor to find the current avatar.
    const inner = disk();
    const paged: StorageDriver = {
      ...inner,
      async list(options?: ListOptions): Promise<ListPage> {
        const all = await inner.list({ ...options, cursor: undefined });
        const from = options?.cursor === undefined ? 0 : Number(options.cursor);
        const next = from + 1;
        return next < all.objects.length
          ? { objects: all.objects.slice(from, next), truncated: true, cursor: String(next) }
          : { objects: all.objects.slice(from, next), truncated: false };
      },
    };
    resetStorage();
    defineStorage({ disks: { local: paged }, default: 'local' });

    expect((await signedAvatarUrl(ORG, MEMBER)) ?? '').toContain('b-second.png');
  });

  test('is the last upload, and never another member’s', async () => {
    const target = avatarTarget(MEMBER);
    // Written in ascending key order so the assertion holds whatever the disk reports for
    // `lastModified` — a local disk's file times can tie inside one millisecond.
    await put(attachmentKey(ORG, target, 'a-first.png'), 'old');
    await put(attachmentKey(ORG, target, 'b-second.png'), 'new');
    await put(attachmentKey(ORG, avatarTarget(OTHER), 'c-theirs.png'), 'theirs');

    const url = (await signedAvatarUrl(ORG, MEMBER)) ?? '';
    expect(url).toContain('b-second.png');
    expect(url).not.toContain('c-theirs.png');

    const theirs = (await signedAvatarUrl(ORG, OTHER)) ?? '';
    expect(theirs).toContain('c-theirs.png');
  });
});
