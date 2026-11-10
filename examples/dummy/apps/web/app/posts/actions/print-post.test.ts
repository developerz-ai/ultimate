/**
 * unit — `printPost`, the app's half of `pdf()`: who may print, into which org, and where the file
 * lands. Every refusal here happens before a browser is asked — a reader or another org's owner
 * that reached Chrome would fail on a missing browser instead of `X_FORBIDDEN`. The print itself
 * is the framework's (`packages/scraping/src/pdf-action.test.ts`).
 */

import { expect, test } from '@ultimat3/testing';
import { printedPostKey, printPost } from './print-post';

test('printing is an export: an author without post:export is refused', async ({
  seed,
  actorFor,
}) => {
  const { post, bruno } = await seed('dev').pick({ post: 'post:tenancy', bruno: 'member:bruno' });

  await expect(
    printPost.as(actorFor(bruno), { orgId: post.orgId, slug: 'tenancy' }),
  ).rejects.toBeUltimateError('X_FORBIDDEN');
});

test('another org’s owner cannot print into this org', async ({ seed, actorFor }) => {
  const { post, mara } = await seed('dev').pick({ post: 'post:tenancy', mara: 'member:mara' });

  await expect(
    printPost.as(actorFor(mara), { orgId: post.orgId, slug: 'tenancy' }),
  ).rejects.toBeUltimateError('X_FORBIDDEN');
});

test('a slug that is not one is refused by the schema', async ({ seed, actorFor }) => {
  const { post, ada } = await seed('dev').pick({ post: 'post:tenancy', ada: 'member:ada' });

  await expect(
    printPost.as(actorFor(ada), { orgId: post.orgId, slug: '../../etc/passwd' }),
  ).rejects.toBeUltimateError('X_INPUT_INVALID');
});

test('the file lands under the org’s own prefix, one per post', () => {
  const orgId = '3f1b7f4a-5c2d-4a5b-9f6e-0a1b2c3d4e5f';
  expect(printedPostKey(orgId, 'tenancy')).toStartWith(`org/${orgId}/`);
  expect(printedPostKey(orgId, 'tenancy')).toEndWith('/posts/printed/tenancy.pdf');
});
