/**
 * unit — attaching an avatar under the app's own scanner, on a real local disk: the scanned upload
 * becomes the one avatar under the member's prefix, an infected one attaches nothing, and two
 * attaches of one member at once leave exactly one avatar — the reason `withLock` is there.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
// `mkdtemp`/`rm` are `node:`-only by necessity: Bun exposes no temp-directory primitive, and a
// disk rooted inside the repo would survive a failed run (`avatar.test.ts`, the same shape).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { memberId as toMemberId, orgId as toOrgId } from '@postly/domain';
import { blankRaster, encodeImage, frozenClock } from '@ultimat3/core';
import { memoryJobDriver } from '@ultimat3/jobs';
import { installJobDriver } from '@ultimat3/jobs/adapter';
import {
  attachmentKey,
  attachmentPrefix,
  defineStorage,
  disk,
  EICAR_TEST_STRING,
  isStorageError,
  localDriver,
  pendingKey,
  promoteAttachment,
  resetStorage,
} from '@ultimat3/storage';
import { installUploadScanner } from '@ultimat3/storage/adapter';
import { postlyUploadScanner } from '../uploads/scanner';
import { avatarTarget, avatarUploadPolicy } from './avatar';
import { attachAvatar } from './avatar-attach';

const ORG = toOrgId('3f1b7f4a-5c2d-4a5b-9f6e-0a1b2c3d4e5f');
const MEMBER = toMemberId('7c9e6679-7425-40de-944b-e07fc1f90ae7');
const PNG = encodeImage(blankRaster(8, 8));

let root = '';
let releases: (() => void)[] = [];

beforeEach(async () => {
  root = await mkdtemp(`${tmpdir()}/postly-avatar-attach-`);
  resetStorage();
  const clock = frozenClock('2026-11-10T09:00:00.000Z');
  defineStorage({
    disks: { local: localDriver({ root, signingSecret: 's', baseUrl: '/_storage/local', clock }) },
    default: 'local',
  });
  releases = [installJobDriver(memoryJobDriver()), installUploadScanner(postlyUploadScanner())];
});

afterEach(async () => {
  for (const release of releases) release();
  resetStorage();
  await rm(root, { recursive: true, force: true });
});

const uploaded = async (name: string, bytes: Uint8Array = PNG): Promise<string> => {
  const key = pendingKey(ORG, name);
  await disk().put(key, bytes, { contentType: 'image/png' });
  return key;
};

const avatarKeys = async (): Promise<readonly string[]> =>
  (await disk().list({ prefix: attachmentPrefix(ORG, avatarTarget(MEMBER)) })).rows.map(
    (row) => row.key,
  );

test('the scanned upload becomes the one avatar; an earlier one and its copies are pruned', async () => {
  const old = attachmentKey(ORG, avatarTarget(MEMBER), 'old.png');
  await disk().put(old, PNG, { contentType: 'image/png' });
  await disk().put(`${old}@w96-r0123abcd.webp`, PNG, { contentType: 'image/webp' });

  const attached = await attachAvatar({
    orgId: ORG,
    memberId: MEMBER,
    key: await uploaded('new.png'),
  });

  expect(attached.key).toBe(attachmentKey(ORG, avatarTarget(MEMBER), 'new.png'));
  expect(await avatarKeys()).toEqual([attached.key]);
});

test('an infected upload is refused and attaches nothing', async () => {
  const infected = new Uint8Array([...PNG, ...new TextEncoder().encode(EICAR_TEST_STRING)]);
  const key = await uploaded('bad.png', infected);

  const code = await attachAvatar({ orgId: ORG, memberId: MEMBER, key }).then(
    () => 'attached',
    (error: unknown) => (isStorageError(error) ? error.code : 'uncoded'),
  );

  expect(code).toBe('X_STORAGE_UPLOAD_INFECTED');
  expect(await avatarKeys()).toEqual([]);
});

test('two attaches of one member at once leave exactly one avatar', async () => {
  const [first, second] = [await uploaded('a.png'), await uploaded('b.png')];

  await Promise.all([
    attachAvatar({ orgId: ORG, memberId: MEMBER, key: first }),
    attachAvatar({ orgId: ORG, memberId: MEMBER, key: second }),
  ]);

  expect(await avatarKeys()).toHaveLength(1);
});

test('a retry after the attach promoted and then failed finishes it, prune included', async () => {
  const old = attachmentKey(ORG, avatarTarget(MEMBER), 'old.png');
  await disk().put(old, PNG, { contentType: 'image/png' });
  const key = await uploaded('new.png');
  // The first attempt: promoted, then failed before its prune and its `warmAvatar` enqueue.
  const first = await promoteAttachment({
    disk: disk(),
    key,
    orgId: ORG,
    target: avatarTarget(MEMBER),
    policy: avatarUploadPolicy,
  });

  const retried = await attachAvatar({ orgId: ORG, memberId: MEMBER, key });

  expect(retried.key).toBe(first.key);
  expect(await avatarKeys()).toEqual([first.key]);
});

test('a retry whose avatar a later attach replaced attaches nothing back', async () => {
  const key = await uploaded('a.png');
  await attachAvatar({ orgId: ORG, memberId: MEMBER, key });
  await attachAvatar({ orgId: ORG, memberId: MEMBER, key: await uploaded('b.png') });

  const code = await attachAvatar({ orgId: ORG, memberId: MEMBER, key }).then(
    () => 'attached',
    (error: unknown) => (isStorageError(error) ? error.code : 'uncoded'),
  );
  // Upload and promoted copy both gone: storage's own refusal, and the newer avatar stays.
  expect(code).toBe('X_STORAGE_NOT_FOUND');
  expect(await avatarKeys()).toEqual([attachmentKey(ORG, avatarTarget(MEMBER), 'b.png')]);
});
