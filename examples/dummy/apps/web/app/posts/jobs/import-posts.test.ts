// importPosts, unit: one CSV on an in-memory disk read into the in-memory driver. What is worth
// failing on is Postly's half — the key held to the input's org, a restored row's shape and where a
// refused row's report lands — never the page walk, which `@ultimat3/jobs` pins itself.
import { db, driver } from '@postly/db';
import { ctxOf, runWithContext, userActor } from '@ultimat3/core';
import { importErrorKey } from '@ultimat3/jobs';
import { defineStorage, disk, memoryStorageDriver, resetStorage } from '@ultimat3/storage';
import { afterEach, beforeEach, describe, expect, test, testName } from '@ultimat3/testing';
import { importPosts } from './import-posts';

const orgId = '00000000-0000-4000-8000-00000000a001';
const otherOrg = '00000000-0000-4000-8000-00000000a002';
const authorId = '00000000-0000-4000-8000-00000000a003';
const importId = '00000000-0000-4000-8000-00000000a004';
const restoredId = '00000000-0000-4000-8000-00000000a005';
const HEADER = 'id,slug,title,status,likeCount,publishedAt,createdAt';

const inOrg = <T>(org: string, run: () => Promise<T>): Promise<T> =>
  runWithContext(ctxOf({ actor: userActor({ id: 'member', orgId: org }) }), run);

const upload = async (key: string, lines: readonly string[]): Promise<void> => {
  await disk().put(key, new TextEncoder().encode(`${[HEADER, ...lines].join('\n')}\n`));
};

beforeEach(() => {
  driver.reset?.();
  resetStorage();
  defineStorage({ disks: { local: memoryStorageDriver() }, default: 'local' });
});
afterEach(() => {
  driver.reset?.();
  resetStorage();
});

describe(testName('unit', 'importPosts'), () => {
  test('a row comes back as a draft under its own id, and a refused row is reported', async ({
    runJobs,
  }) => {
    const key = `org/${orgId}/imports/posts/one.csv`;
    await upload(key, [
      `${restoredId},restored,Restored,published,3,,2026-11-01T00:00:00.000Z`,
      `not-a-uuid,broken,Broken,draft,0,,2026-11-01T00:00:00.000Z`,
    ]);
    const trace = await runJobs(importPosts, { orgId, importId, authorId, key });
    const run = trace.executions.find((one) => one.job === importPosts.name);
    expect([run?.outcome, run?.error]).toEqual(['completed', undefined]);
    expect(run?.result).toMatchObject({ rows: 1, rejected: 1 });

    const [restored] = await inOrg(orgId, () => db.posts.all());
    expect(restored).toMatchObject({
      id: restoredId,
      orgId,
      authorId,
      slug: 'restored',
      title: 'Restored',
      status: 'draft',
      excerpt: '',
      body: '',
    });
    // The first page's report, under this import's own prefix: the line and field, never the value.
    const { errorPrefix } = (run?.result ?? { errorPrefix: '' }) as {
      readonly errorPrefix: string;
    };
    // Under the org, beside its exports: a report outside `org/<id>/` is no tenant's to read.
    expect(errorPrefix.startsWith(`org/${orgId}/imports/posts/${importId}/`)).toBe(true);
    const report = await disk().get(importErrorKey(errorPrefix, 0));
    const text = new TextDecoder().decode(report.bytes);
    expect(text).toContain('"line":3');
    expect(text).not.toContain('not-a-uuid');
  });

  test('a key under another org is refused before any row is read', async ({ runJobs }) => {
    const theirs = `org/${otherOrg}/imports/posts/theirs.csv`;
    await upload(theirs, [`${restoredId},theirs,Theirs,draft,0,,2026-11-01T00:00:00.000Z`]);
    const trace = await runJobs(importPosts, { orgId, importId, authorId, key: theirs });
    const run = trace.executions.find((one) => one.job === importPosts.name);
    expect(run?.outcome).toBe('dead-lettered');
    expect(run?.error).toContain('X_VALIDATION_FAILED');
    expect(await inOrg(orgId, () => db.posts.all())).toEqual([]);
  });
});
