// postExcerpts, SWEPT: one whole pass run by a worker in this process, over rows in the in-memory
// driver. A sweep rewrites rows no user asked it to, so what is worth failing on is that it
// completes at all, reaches every tenant's rows, fills the one column it owns and leaves a row
// somebody already wrote alone.
import { db, driver, type Post } from '@postly/db';
import { createContext, runWithContext, userActor } from '@ultimat3/core';
import { afterEach, beforeEach, describe, expect, test, testName } from '@ultimat3/testing';
import { postExcerpts } from './post-excerpts';

const orgA = '00000000-0000-4000-8000-000000000002';
const orgB = '00000000-0000-4000-8000-000000000009';
const author = '00000000-0000-4000-8000-000000000003';

/** What a request is to the handle: an actor, whose org every read and write runs under. */
const inOrg = <T>(orgId: string, run: () => Promise<T>): Promise<T> =>
  runWithContext(createContext({ actor: userActor({ id: 'member', orgId }) }), run);

const store = (orgId: string, slug: string, excerpt = ''): Promise<Post> =>
  inOrg(orgId, () =>
    db.posts.insert({
      orgId,
      authorId: author,
      slug,
      title: `The ${slug} post`,
      excerpt,
      body: `The body the ${slug} excerpt is derived from.`,
    }),
  );

const excerptsOf = (orgId: string): Promise<readonly string[]> =>
  inOrg(orgId, async () => (await db.posts.all()).map((row) => row.excerpt));

// One store per process: without this, one test's rows are the next test's fixtures. Before as
// well as after: these tests assert a WHOLE tenant's rows, so they start from an empty store even
// when an earlier file in this process left rows behind (repo.test.ts once did, under org …0009).
beforeEach(() => {
  driver.reset?.();
});
afterEach(() => {
  driver.reset?.();
});

describe(testName('unit', 'postExcerpts'), () => {
  test('one pass fills the blank excerpts of every tenant, and completes', async ({ runJobs }) => {
    await store(orgA, 'first');
    await store(orgB, 'second');
    const trace = await runJobs(postExcerpts, {});
    // `completed`, not retried: a handler the table refuses retries its first page for ever.
    expect(trace.executions.map((run) => run.outcome)).toEqual(['completed']);
    expect(await excerptsOf(orgA)).toEqual(['The body the first excerpt is derived from.']);
    expect(await excerptsOf(orgB)).toEqual(['The body the second excerpt is derived from.']);
  });

  test('the pass writes the excerpt and nothing else', async ({ runJobs }) => {
    const stored = await store(orgA, 'only');
    await runJobs(postExcerpts, {});
    const [swept] = await inOrg(orgA, () => db.posts.all());
    expect(swept).toEqualRow({
      ...stored,
      excerpt: 'The body the only excerpt is derived from.',
      updatedAt: swept?.updatedAt,
    });
  });

  test('a row somebody already wrote is not visited, and a second pass changes nothing', async ({
    runJobs,
  }) => {
    await store(orgA, 'blank');
    await store(orgA, 'written', 'Hand-written.');
    await runJobs(postExcerpts, {});
    const first = [...(await excerptsOf(orgA))].sort();
    expect(first).toEqual(['Hand-written.', 'The body the blank excerpt is derived from.']);
    // Nothing is behind any more, so the same sweep kicked again finds no row to write.
    await runJobs(postExcerpts, { force: true });
    expect([...(await excerptsOf(orgA))].sort()).toEqual(first);
  });
});
