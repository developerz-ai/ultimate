// An org's export file uploaded IN PARTS and imported: the five actions `uploadFile({ multipart })`
// calls, on the in-memory disk, end to end — grant, sign, send, list (the resume), complete, and
// the `posts.import` run it queues on exactly the file the parts made. Plus every refusal that
// keeps one org's session out of another's reach.

import { userActor } from '@ultimat3/core';
import { jobDriver, memoryJobDriver } from '@ultimat3/jobs';
import { installJobDriver } from '@ultimat3/jobs/adapter';
import {
  acceptSignedPart,
  defineStorage,
  disk,
  memoryStorageDriver,
  resetStorage,
} from '@ultimat3/storage';
import { installUploadScanner } from '@ultimat3/storage/adapter';
import { afterEach, beforeEach, expect, unitTest } from '@ultimat3/testing';
import { postlyUploadScanner } from '../uploads/scanner';
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

// The install answers its own undo, which puts back whatever was installed before it.
let release = (): void => {};
beforeEach(() => {
  resetStorage();
  defineStorage({
    disks: { local: memoryStorageDriver({ signingSecret: 'test' }) },
    default: 'local',
  });
  release = installJobDriver(memoryJobDriver());
});
afterEach(() => {
  resetStorage();
  release();
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
    // The session lands under `pending/`, named by its import id: the scanner refuses a target.
    expect(grant.key).toBe(`org/${ORG}/pending/${grant.importId}.csv`);
    const ref = { orgId: ORG, key: grant.key, uploadId: grant.uploadId };

    await send(grant, 1);
    // The resume: what landed is listed, so an interrupted client sends only part 2.
    expect((await listPostsImportParts.as(admin, ref)).map((part) => part.partNumber)).toEqual([1]);
    await send(grant, 2);

    const done = await completePostsImport.as(admin, {
      ...ref,
      parts: [{ partNumber: 1 }, { partNumber: 2 }],
    });
    const promoted = `org/${ORG}/imports/posts/${grant.importId}/${grant.importId}.csv`;
    expect(done).toEqual({ importId: grant.importId, key: promoted, size: SIZE });
    expect((await disk().get(promoted)).bytes.byteLength).toBe(SIZE);
    expect(await disk().stat(grant.key)).toBeUndefined();
    const [queued] = (await jobDriver()?.introspect?.list()) ?? [];
    expect(queued?.input).toEqual({
      orgId: ORG,
      importId: grant.importId,
      authorId: admin.id,
      key: promoted,
    });
  },
);

unitTest(
  'a file the sandbox holds is quarantined; the same complete again imports it once cleared',
  async () => {
    // Every file to the sandbox, as a past-the-inline-limit export would go.
    const unscan = installUploadScanner(postlyUploadScanner({ inlineMaxBytes: 0 }));
    try {
      const grant = await open();
      await send(grant, 1);
      await send(grant, 2);
      const complete = {
        orgId: ORG,
        key: grant.key,
        uploadId: grant.uploadId,
        parts: [{ partNumber: 1 }, { partNumber: 2 }],
      };

      await expect(completePostsImport.as(admin, complete)).rejects.toBeUltimateError(
        'X_STORAGE_QUARANTINED',
      );
      // Held: assembled and still pending, and nothing queued to read it.
      expect((await disk().stat(grant.key))?.size).toBe(SIZE);
      expect((await jobDriver()?.introspect?.list()) ?? []).toEqual([]);

      // The session is gone now; the retry promotes the assembled file the sandbox cleared.
      const done = await completePostsImport.as(admin, complete);
      expect(done.key).toBe(`org/${ORG}/imports/posts/${grant.importId}/${grant.importId}.csv`);
      expect((await jobDriver()?.introspect?.list())?.length).toBe(1);
    } finally {
      unscan();
    }
  },
);

unitTest('a held file swapped for other bytes is not attached on the next complete', async () => {
  const unscan = installUploadScanner(postlyUploadScanner({ inlineMaxBytes: 0 }));
  try {
    const grant = await open();
    await send(grant, 1);
    await send(grant, 2);
    const complete = {
      orgId: ORG,
      key: grant.key,
      uploadId: grant.uploadId,
      parts: [{ partNumber: 1 }, { partNumber: 2 }],
    };
    await expect(completePostsImport.as(admin, complete)).rejects.toBeUltimateError(
      'X_STORAGE_QUARANTINED',
    );
    // What a still-live presigned PUT could do while the file is held: other bytes, same key.
    await disk().put(grant.key, new TextEncoder().encode('id,slug\nswapped,in\n'), {
      contentType: 'text/csv',
    });

    await expect(completePostsImport.as(admin, complete)).rejects.toBeUltimateError(
      'X_STORAGE_QUARANTINED',
    );
    expect(
      await disk().stat(`org/${ORG}/imports/posts/${grant.importId}/${grant.importId}.csv`),
    ).toBeUndefined();
    expect((await jobDriver()?.introspect?.list()) ?? []).toEqual([]);
  } finally {
    unscan();
  }
});

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
  // A session, or a file the scanner holds: an abandoned one is swept too, after the window.
  expect(isPostsImportKey(`org/${ORG}/pending/${ORG}.csv`)).toBe(true);
  expect(isPostsImportKey(`org/${ORG}/pending/${ORG}.png`)).toBe(false);
  expect(isPostsImportKey(`org/${ORG}/member/m/avatar/a.png`)).toBe(false);
  expect(isPostsImportKey(`org/${ORG}/exports/posts/3/part-1.csv`)).toBe(false);
  expect(isPostsImportKey(`pending/org/${ORG}/imports/posts/1/f.csv`)).toBe(false);
});
