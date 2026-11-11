// The `input`s apps/web/exercise.ts binds for the storage and push primitives, run outside the pass:
// each must hand its primitive a value the primitive really takes — an upload session the posts
// import actions resume, a key inside the org the job runs for, a subscription a browser would send.
import { userActor } from '@ultimat3/core';
import { memoryJobDriver } from '@ultimat3/jobs';
import { installJobDriver } from '@ultimat3/jobs/adapter';
import { defineStorage, disk, memoryStorageDriver, resetStorage } from '@ultimat3/storage';
import { afterEach, beforeEach, expect, unitTest } from '@ultimat3/testing';
import { abortPostsImport } from './app/posts/actions/abort-posts-import';
import { completePostsImport } from './app/posts/actions/complete-posts-import';
import { grantPostsImport } from './app/posts/actions/grant-posts-import';
import { listPostsImportParts } from './app/posts/actions/list-posts-import-parts';
import { signPostsImportPart } from './app/posts/actions/sign-posts-import-part';
import { importIdOf, isPostsImportKey } from './app/posts/import-upload';
import { exercise } from './exercise';

const ORG = '00000000-0000-4000-8000-00000000e101';
const admin = userActor({
  id: '00000000-0000-4000-8000-00000000e102',
  orgId: ORG,
  roles: ['admin'],
});
const DRAWN = { orgId: ORG } as const;

/** What the pass would hand `name`'s primitive: the entry's `input` over the draw. */
async function inputOf(name: string): Promise<Record<string, unknown>> {
  const entry = exercise.entries.get(name);
  if (entry === undefined || !('input' in entry) || entry.input === undefined)
    return expect.unreachable(`apps/web/exercise.ts binds no input for ${name}`);
  return (await entry.input(DRAWN)) as Record<string, unknown>;
}

/** The same, read through `primitive`'s own input schema — which is what the pass's call does. */
async function inputFor<I>(
  name: string,
  primitive: { readonly input: { parse(value: unknown): I } },
): Promise<I> {
  return primitive.input.parse(await inputOf(name));
}

/** Unpadded base64url back to bytes, refusing any character outside that alphabet. */
const bytesOf = (text: string): Uint8Array => {
  expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
  const padded = text.replaceAll('-', '+').replaceAll('_', '/');
  return Uint8Array.from(atob(padded + '='.repeat((4 - (padded.length % 4)) % 4)), (c) =>
    c.charCodeAt(0),
  );
};

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

unitTest('the upload grants draw a filename and type the policy signs', async () => {
  const grant = await grantPostsImport.as(
    admin,
    await inputFor('grantPostsImport', grantPostsImport),
  );
  expect(isPostsImportKey(grant.key)).toBe(true);
  expect(await inputOf('grantAvatarUpload')).toMatchObject({
    filename: 'me.png',
    contentType: 'image/png',
  });
});

unitTest('every posts-import session call resumes the session its input opened', async () => {
  const signed = await signPostsImportPart.as(
    admin,
    await inputFor('signPostsImportPart', signPostsImportPart),
  );
  expect(signed.url).toBeString();
  expect(
    await listPostsImportParts.as(
      admin,
      await inputFor('listPostsImportParts', listPostsImportParts),
    ),
  ).toEqual([]);
  await abortPostsImport.as(admin, await inputFor('abortPostsImport', abortPostsImport));

  const complete = await inputFor('completePostsImport', completePostsImport);
  const done = await completePostsImport.as(admin, complete);
  // Promoted off the session's `pending/` key onto the import's own, under the id it was opened as.
  expect(done.key).toBe(
    `org/${ORG}/imports/posts/${importIdOf(ORG, complete.key)}/${done.importId}.csv`,
  );
  expect(new TextDecoder().decode((await disk().get(done.key)).bytes)).toStartWith('id,slug,');
});

unitTest(
  'the job inputs name a key inside the drawn org, holding the bytes they read',
  async () => {
    const avatar = await inputOf('warmAvatar');
    expect(String(avatar['key'])).toStartWith(`org/${ORG}/`);
    // The PNG signature: a real image for the job to decode, not a placeholder string.
    const png = (await disk().get(String(avatar['key']))).bytes;
    expect([...png.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);

    const imported = await inputOf('posts.import');
    const key = String(imported['key']);
    expect(isPostsImportKey(key)).toBe(true);
    // The promoted file's key, as `completePostsImport` enqueues it: under its own import's prefix.
    expect(key).toStartWith(`org/${ORG}/imports/posts/${String(imported['importId'])}/`);
    expect(new TextDecoder().decode((await disk().get(key)).bytes)).toStartWith('id,slug,');
  },
);

unitTest('subscribePush draws a Chromium subscription with a real P-256 key', async () => {
  const sub = await inputOf('subscribePush');
  expect(String(sub['endpoint'])).toStartWith('https://fcm.googleapis.com/fcm/send/');
  const keys = sub['keys'] as { p256dh: string; auth: string };
  const point = bytesOf(keys.p256dh);
  // An uncompressed P-256 point: 0x04, then x and y.
  expect({ length: point.byteLength, prefix: point[0] }).toEqual({ length: 65, prefix: 4 });
  expect(bytesOf(keys.auth).byteLength).toBe(16);
});
