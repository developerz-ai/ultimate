/**
 * contract — the posts slice's `uploadFlow()` pair on a seeded database and a memory disk: the
 * author's upload lands on their post's attachment prefix only after confirm, a retried confirm
 * answers the same object, and every caller who may not edit the post is refused on both halves.
 */

import { blankRaster, encodeImage } from '@ultimat3/core';
import {
  attachmentPrefix,
  defineStorage,
  disk,
  memoryStorageDriver,
  resetStorage,
} from '@ultimat3/storage';
import { installUploadScanner } from '@ultimat3/storage/adapter';
import { afterEach, beforeEach, contractTest, expect, test } from '@ultimat3/testing';
import { postlyUploadScanner } from '../../uploads/scanner';
import { confirmPostAttachment, requestPostAttachment } from './post-attachment';

const PNG = encodeImage(blankRaster(8, 8));
const FILE = { filename: 'chart.png', contentType: 'image/png', size: PNG.byteLength } as const;

let release = (): void => {};
beforeEach(() => {
  resetStorage();
  defineStorage({
    disks: { local: memoryStorageDriver({ signingSecret: 't' }) },
    default: 'local',
  });
  release = installUploadScanner(postlyUploadScanner());
});
afterEach(() => {
  release();
  resetStorage();
});

test('the author’s upload reaches the post only through confirm, and a retry answers it again', async ({
  seed,
  actorFor,
}) => {
  const { draft, author } = await seed('dev').pick({
    draft: 'post:draft-money',
    author: 'member:bruno',
  });
  const as = actorFor(author);
  const grant = await requestPostAttachment.as(as, { ...FILE, id: draft.id });
  const prefix = attachmentPrefix(draft.orgId, {
    entity: 'post',
    id: draft.id,
    field: 'attachment',
  });
  expect(grant.key.startsWith(prefix)).toBe(false);
  await disk().put(grant.key, PNG, { contentType: 'image/png' });

  const attached = await confirmPostAttachment.as(as, { key: grant.key, id: draft.id });
  expect(attached.key.startsWith(prefix)).toBe(true);
  expect(attached).toMatchObject({ contentType: 'image/png', size: PNG.byteLength });
  expect(await confirmPostAttachment.as(as, { key: grant.key, id: draft.id })).toEqual(attached);
});

test('a caller who may not edit the post is refused on both halves', async ({ seed, actorFor }) => {
  const { draft, adas, author, reader, stranger } = await seed('dev').pick({
    draft: 'post:draft-money',
    adas: 'post:tenancy', // written by Ada, not Bruno
    author: 'member:bruno',
    reader: 'member:kenji',
    stranger: 'member:mara',
  });
  const refused = [
    [author, adas.id], // holds the right, not the authorship
    [reader, draft.id], // the org's, without the right
    [stranger, draft.id], // another org: the post loads as nothing
    [author, undefined], // names no post
    [author, 'not-a-uuid'], // names no post either, and never reaches the read
  ] as const;
  for (const [member, id] of refused) {
    const as = actorFor(member);
    await expect(requestPostAttachment.as(as, { ...FILE, id })).rejects.toBeUltimateError(
      'X_FORBIDDEN',
    );
    await expect(
      confirmPostAttachment.as(as, { key: `org/${member.orgId}/pending/x.png`, id }),
    ).rejects.toBeUltimateError('X_FORBIDDEN');
  }
});

contractTest('the grant passes the contract an action owes', async ({ seed, actorFor }) => {
  const { draft, author } = await seed('dev').pick({
    draft: 'post:draft-money',
    author: 'member:bruno',
  });
  const exercise = {
    actor: actorFor(author),
    input: (drawn: unknown) => ({ ...(drawn as object), ...FILE, id: draft.id }),
  };
  for (const contract of requestPostAttachment.contract({ exercise })) await contract.run();
});
