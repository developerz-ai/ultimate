// An org's export file uploaded IN PARTS and imported: the five actions `uploadFile({ multipart })`
// calls, on the in-memory disk, end to end — grant, sign, send, list (the resume), complete, and
// the `posts.import` run it queues on exactly the file the parts made. Plus every refusal that
// keeps one org's session out of another's reach.

import { userActor } from '@ultimat3/core';
import { jobDriver, memoryJobDriver, resetJobDriver, setJobDriver } from '@ultimat3/jobs';
import {
  acceptSignedPart,
  defineStorage,
  disk,
  memoryStorageDriver,
  resetStorage,
} from '@ultimat3/storage';
import { afterEach, beforeEach, expect, unitTest } from '@ultimat3/testing';
import { abortPostsImport } from './actions/abort-posts-import';
import { completePostsImport } from './actions/complete-posts-import';
import { grantPostsImport } from './actions/grant-posts-import';
import { listPostsImportParts } from './actions/list-posts-import-parts';
import { signPostsImportPart } from './actions/sign-posts-import-part';
import { isPostsImportKey } from './import-upload';

const ORG = '00000000-0000-4000-8000-00000000e001';
const OTHER = '00000000-0000-4000-8000-00000000e002';
const admin = userActor({
  id: '00000000-0000-4000-8000-00000000e003',
  orgId: ORG,
  roles: ['admin'],
});
const elsewhere = userActor({
  id: '00000000-0000-4000-8000-00000000e004',
  orgId: OTHER,
  roles: ['admin'],
});
const reader = userActor({
  id: '00000000-0000-4000-8000-00000000e005',
  orgId: ORG,
  roles: ['reader'],
});

/** Five MiB and a tail: two parts, the smallest file that is really in parts. */
const SIZE = 5 * 1024 * 1024 + 7;
const file = new Uint8Array(SIZE).map((_, at) => at % 251);

const previous = jobDriver();
beforeEach(() => {
  resetStorage();
  defineStorage({
    disks: { local: memoryStorageDriver({ signingSecret: 'test' }) },
    default: 'local',
  });
  setJobDriver(memoryJobDriver());
});
afterEach(() => {
  resetStorage();
  if (previous === undefined) resetJobDriver();
  else setJobDriver(previous);
});

const open = () =>
  grantPostsImport.as(admin, {
    orgId: ORG,
    filename: 'posts.csv',
    contentType: 'text/csv',
    size: SIZE,
  });

/** One part through its signed URL, as the browser's PUT reaches the memory disk. */
const send = async (session: { key: string; uploadId: string; partBytes: number }, n: number) => {
  const bytes = file.slice((n - 1) * session.partBytes, Math.min(n * session.partBytes, SIZE));
  const ref = { orgId: ORG, key: session.key, uploadId: session.uploadId };
  const { url } = await signPostsImportPart.as(admin, {
    ...ref,
    partNumber: n,
    size: bytes.byteLength,
  });
  await acceptSignedPart({ url, disk: disk(), orgId: ORG, bytes });
};

unitTest(
  'grant, two parts, a resume read, complete: the file lands and its import is queued',
  async () => {
    const grant = await open();
    expect(grant.maxParts).toBe(2);
    expect(isPostsImportKey(grant.key)).toBe(true);
    expect(grant.key.startsWith(`org/${ORG}/imports/posts/${grant.importId}/`)).toBe(true);
    const ref = { orgId: ORG, key: grant.key, uploadId: grant.uploadId };

    await send(grant, 1);
    // The resume: what landed is listed, so an interrupted client sends only part 2.
    expect((await listPostsImportParts.as(admin, ref)).map((part) => part.partNumber)).toEqual([1]);
    await send(grant, 2);

    const done = await completePostsImport.as(admin, {
      ...ref,
      parts: [{ partNumber: 1 }, { partNumber: 2 }],
    });
    expect(done).toEqual({ importId: grant.importId, key: grant.key, size: SIZE });
    expect((await disk().get(grant.key)).bytes.byteLength).toBe(SIZE);
    const [queued] = (await jobDriver()?.introspect?.list()) ?? [];
    expect(queued?.input).toEqual({
      orgId: ORG,
      importId: grant.importId,
      authorId: admin.id,
      key: grant.key,
    });
  },
);

unitTest('a part missing at complete is refused, and nothing is queued', async () => {
  const grant = await open();
  await send(grant, 1);
  const ref = { orgId: ORG, key: grant.key, uploadId: grant.uploadId };
  await expect(
    completePostsImport.as(admin, { ...ref, parts: [{ partNumber: 1 }, { partNumber: 2 }] }),
  ).rejects.toBeUltimateError('X_STORAGE_PARTS_INVALID');
  expect((await jobDriver()?.introspect?.list()) ?? []).toEqual([]);
});

unitTest('abort drops the session; a non-CSV or a reader is refused before one opens', async () => {
  const grant = await open();
  await abortPostsImport.as(admin, { orgId: ORG, key: grant.key, uploadId: grant.uploadId });
  expect(await disk().multipart?.listUploads(`org/${ORG}/`)).toEqual([]);
  await expect(
    grantPostsImport.as(admin, {
      orgId: ORG,
      filename: 'x.exe',
      contentType: 'application/x-msdownload',
      size: 9,
    }),
  ).rejects.toBeUltimateError('X_STORAGE_TYPE_REJECTED');
  await expect(
    grantPostsImport.as(reader, {
      orgId: ORG,
      filename: 'p.csv',
      contentType: 'text/csv',
      size: 9,
    }),
  ).rejects.toBeUltimateError('X_FORBIDDEN');
});

unitTest('another org names this org’s session and reaches nothing', async () => {
  const grant = await open();
  const ref = { orgId: ORG, key: grant.key, uploadId: grant.uploadId };
  // Its own org in the input: the policy passes, and the key is still not under it.
  await expect(
    listPostsImportParts.as(elsewhere, { ...ref, orgId: OTHER }),
  ).rejects.toBeUltimateError('X_STORAGE_ORG_MISMATCH');
  // This org in the input: the policy refuses before the disk is asked.
  await expect(listPostsImportParts.as(elsewhere, ref)).rejects.toBeUltimateError('X_FORBIDDEN');
});

// `purgeImports` sweeps `org/` scoped by this predicate: an avatar or an export answering `true`
// here would be deleted a week after upload.
unitTest('the purge scope is every org’s imports and nothing beside them', () => {
  expect(isPostsImportKey(`org/${ORG}/imports/posts/1/f.csv`)).toBe(true);
  expect(isPostsImportKey(`org/${OTHER}/imports/posts/2/f.csv`)).toBe(true);
  expect(isPostsImportKey(`org/${ORG}/member/m/avatar/a.png`)).toBe(false);
  expect(isPostsImportKey(`org/${ORG}/exports/posts/3/part-1.csv`)).toBe(false);
  expect(isPostsImportKey(`pending/org/${ORG}/imports/posts/1/f.csv`)).toBe(false);
});
