// eraseMember and exportMember, unit, on the in-memory driver and disk. What is worth failing on is
// Postly's half — which of a member's rows go, which stay, and that nobody else's are touched —
// never the paging or the resume, which `@ultimat3/jobs` pins itself.
import { db, driver } from '@postly/db';
import { ctxOf, runWithContext, userActor } from '@ultimat3/core';
import { defineStorage, disk, memoryStorageDriver, resetStorage } from '@ultimat3/storage';
import { afterEach, beforeEach, describe, expect, test, testName } from '@ultimat3/testing';
import { ERASED_EMAIL } from '../subject';
import { eraseMember } from './erase-member';
import { exportMember, memberExportPrefix } from './export-member';

const orgId = '00000000-0000-4000-8000-00000000e001';
const me = '00000000-0000-4000-8000-00000000e002';
const you = '00000000-0000-4000-8000-00000000e003';
const myPost = '00000000-0000-4000-8000-00000000e004';
const yourPost = '00000000-0000-4000-8000-00000000e005';
const exportId = '00000000-0000-4000-8000-00000000e006';
const avatar = `org/${orgId}/member/${me}/avatar/a.png`;

const inOrg = <T>(run: () => Promise<T>): Promise<T> =>
  runWithContext(ctxOf({ actor: userActor({ id: 'owner', orgId }) }), run);

const post = (id: string, authorId: string) => ({
  id,
  orgId,
  authorId,
  slug: `p-${id.slice(-4)}`,
  title: 'A post',
  excerpt: '',
  body: '',
});

beforeEach(async () => {
  driver.reset?.();
  resetStorage();
  defineStorage({ disks: { local: memoryStorageDriver() }, default: 'local' });
  await disk().put(avatar, new TextEncoder().encode('png'));
  await inOrg(async () => {
    await db.orgs.insert({ id: orgId, slug: 'erase-org', name: 'Erase' });
    for (const [id, name] of [
      [me, 'Me'],
      [you, 'You'],
    ] as const) {
      await db.members.insert({ id, orgId, userId: id, email: `${name}@x.test`, name });
    }
    await db.posts.insert(post(myPost, me));
    await db.posts.insert(post(yourPost, you));
    await db.comments.insert({
      id: crypto.randomUUID(),
      orgId,
      postId: yourPost,
      authorId: me,
      body: 'mine',
    });
    await db.comments.insert({
      id: crypto.randomUUID(),
      orgId,
      postId: myPost,
      authorId: you,
      body: 'yours',
    });
    await db.likes.insert({ orgId, postId: yourPost, memberId: me });
    await db.likes.insert({ orgId, postId: myPost, memberId: you });
  });
});
afterEach(() => {
  driver.reset?.();
  resetStorage();
});

describe(testName('unit', 'eraseMember'), () => {
  test('the member is anonymized, their posts kept, what is only theirs gone', async ({
    runJobs,
  }) => {
    const trace = await runJobs(eraseMember, { orgId, memberId: me });
    const run = trace.executions.find((one) => one.job === eraseMember.name);
    expect([run?.outcome, run?.error]).toEqual(['completed', undefined]);

    const state = await inOrg(async () => ({
      members: (await db.members.all()).map((m) => [m.id, m.email, m.name]),
      posts: (await db.posts.all()).map((p) => p.id).sort(),
      comments: (await db.comments.all()).map((c) => c.body),
      likes: (await db.likes.all()).map((l) => l.memberId),
    }));
    expect(state.members).toContainEqual([me, ERASED_EMAIL, '']);
    expect(state.members).toContainEqual([you, 'You@x.test', 'You']);
    expect(state.posts).toEqual([myPost, yourPost].sort());
    expect(state.comments).toEqual(['yours']);
    expect(state.likes).toEqual([you]);
    expect(await disk().exists(avatar)).toBe(false);
  });
});

describe(testName('unit', 'exportMember'), () => {
  test('every table it reaches, and an index naming what an erase does to each', async ({
    runJobs,
  }) => {
    const trace = await runJobs(exportMember, { orgId, memberId: me, exportId });
    const run = trace.executions.find((one) => one.job === exportMember.name);
    expect([run?.outcome, run?.error]).toEqual(['completed', undefined]);
    const prefix = memberExportPrefix({ orgId, memberId: me, exportId });
    const index = JSON.parse(
      new TextDecoder().decode((await disk().get(`${prefix}/index.json`)).bytes),
    ) as { tables: { name: string; treatment: string; rows: number }[] };
    expect(Object.fromEntries(index.tables.map((t) => [t.name, [t.treatment, t.rows]]))).toEqual({
      members: ['anonymize', 1],
      posts: ['retain', 1],
      comments: ['delete', 1],
      likes: ['delete', 1],
      post_reviews: ['delete', 0],
      avatars: ['erase', 1],
    });
  });
});
