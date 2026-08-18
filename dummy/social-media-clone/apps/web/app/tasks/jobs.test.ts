// job — the sweep, driven through a real worker rather than by calling `run()` directly. A job's
// execution surface IS the queue: claim, execute, ack, dedupe. Calling the body by hand would test
// a function and claim to have tested a job.

import { afterAll, beforeEach, expect, test } from 'bun:test';
import { db, driver, seedDemo } from '@social-media-clone/db';
import { seedId } from '@ultimat3/entity';
import { createRunJobs, type RunJobs } from '@ultimat3/testing';
import { resetDemo, sweepOrphanMedia } from './jobs';
import { mediaById, missingDemoMarkers, pendingMediaBefore } from './repo';

/** The seed's deliberate orphan, and the attached row that must survive every sweep. */
const ORPHAN = seedId('media:orphan');
const ATTACHED = seedId('media:tenancy-cover');

/** After both seeded uploads (2026-03-01 and 2026-03-02), so the cutoff is not the thing under test. */
const CUTOFF = '2026-04-01T00:00:00.000Z';
const LATER = '2026-05-01T00:00:00.000Z';

let jobs: RunJobs;

beforeEach(async () => {
  // Emptied, THEN re-seeded: a replay is `on conflict do nothing` (packages/entity/src/seed.ts:274),
  // so it restores a row that is gone and never a value a test changed — `media:orphan` swept to
  // `orphan` above stays `orphan` for every test after it. `reset?.()` is the framework's test seam
  // for exactly this, and it is the only thing that makes these tests order-independent.
  driver.reset?.();
  await seedDemo();
  await jobs?.[Symbol.asyncDispose]();
  jobs = await createRunJobs();
});

afterAll(async () => {
  await jobs?.[Symbol.asyncDispose]();
});

test('neither scheduled job carries a tenant, because no entity here has one', () => {
  // Visibility in this app is relational, not a tenant column, so `'none'` strips an org that was
  // never there rather than failing a read closed — which the sweep test below proves through a
  // real worker. A `tenant: (input) => …` here would put an org on the actor that matches no row.
  expect(sweepOrphanMedia.tenantFor({ before: CUTOFF })).toBeUndefined();
  expect(resetDemo.tenantFor({ occurrence: CUTOFF })).toBeUndefined();
});

test('the sweep collects the seeded pending upload and leaves the attached one alone', async () => {
  expect((await mediaById(ORPHAN))?.state).toBe('pending');

  const trace = await jobs(sweepOrphanMedia, { before: CUTOFF });

  expect(trace.executions).toHaveLength(1);
  expect(trace.executions[0]?.outcome).toBe('completed');
  expect((await mediaById(ORPHAN))?.state).toBe('orphan');
  // The attached row is the control: it is older than the cutoff too, and `state` is the only
  // reason it survives. A sweep that keyed off `postId IS NULL` would pass the first assertion
  // and fail this one the day an upload is claimed before its post is published.
  expect((await mediaById(ATTACHED))?.state).toBe('attached');
});

test('the idempotency key derives from input alone — same occurrence, one job', async () => {
  const key = sweepOrphanMedia.idempotencyKeyFor({ before: CUTOFF });
  expect(sweepOrphanMedia.idempotencyKeyFor({ before: CUTOFF })).toBe(key);
  // A different occurrence is a different job. If the key ignored its input, every hour would
  // collide with the first run and the sweep would fire exactly once, ever.
  expect(sweepOrphanMedia.idempotencyKeyFor({ before: LATER })).not.toBe(key);

  const first = await jobs.enqueue(sweepOrphanMedia, { before: CUTOFF });
  const replay = await jobs.enqueue(sweepOrphanMedia, { before: CUTOFF });
  expect(first.deduped).toBe(false);
  expect(replay.deduped).toBe(true);
  expect(await jobs.depth(sweepOrphanMedia)).toBe(1);
});

test('replay is a no-op: the body writes the state it read, so a second pass changes nothing', async () => {
  await jobs(sweepOrphanMedia, { before: CUTOFF });
  const afterFirst = await mediaById(ORPHAN);

  // A LATER cutoff is a different key, so this really executes rather than deduping — which is
  // the case that matters: the body runs a second time over rows it already collected.
  const trace = await jobs(sweepOrphanMedia, { before: LATER });
  expect(trace.executions).toHaveLength(2);
  expect(trace.executions[1]?.outcome).toBe('completed');

  const afterSecond = await mediaById(ORPHAN);
  expect(afterSecond?.state).toBe(afterFirst?.state);
  expect(afterSecond?.state).toBe('orphan');
  expect((await mediaById(ATTACHED))?.state).toBe('attached');
  // Nothing is left pending before the cutoff — the sweep converged rather than accumulating.
  expect(await pendingMediaBefore(new Date(LATER))).toHaveLength(0);
});

test('an upload newer than the cutoff is not collected — the grace period is real', async () => {
  const beforeAnything = '2026-01-01T00:00:00.000Z';
  await jobs(sweepOrphanMedia, { before: beforeAnything });
  expect((await mediaById(ORPHAN))?.state).toBe('pending');
});

/**
 * The failure case first, and it is the one that decides whether this job may exist at all: it
 * deletes five tables, so it must refuse a database that is not the demo's. The signal is the
 * demo's own seeded accounts, NOT `DATABASE_URL` — that variable now selects Postgres for the
 * deployed demo (packages/db/src/client.ts), so the old check would have refused every occurrence.
 */
test('the reset refuses a store that does not hold the demo accounts', async () => {
  driver.reset?.();
  try {
    expect(await missingDemoMarkers()).toHaveLength(2);

    const trace = await jobs(resetDemo, { occurrence: CUTOFF });
    // `retried`, not `failed`: the guard throws on attempt 1 of 3. What matters is that no attempt
    // completed and the refusal is the coded one, not that the queue gave up on this pass.
    expect(trace.executions.map((execution) => execution.outcome)).not.toContain('completed');
    // `JobExecution.error` is the rendered message, not the object — the code is the first token.
    expect(trace.executions[0]?.error).toContain('X_DEMO_RESET_UNSAFE');
    // The reset re-seeds at the end, so a guard that let this through would leave the markers here.
    expect(await missingDemoMarkers()).toHaveLength(2);
  } finally {
    // Put the world back for whatever runs next, in a `finally` so a failed expectation above
    // cannot leave an empty store behind it.
    await seedDemo();
  }
});

test('the reset removes what a visitor added and LEAVES the seeded rows', async () => {
  expect(await missingDemoMarkers()).toHaveLength(0);
  const seededPosts = (await db.posts.limit(50).all()).length;
  expect(seededPosts).toBeGreaterThan(0);

  const visitorPost = await db.posts.insert({
    authorId: seedId('user:user'),
    body: 'something a visitor typed',
    audience: 'public',
    likeCount: 0,
    commentCount: 0,
    mediaCount: 0,
  });

  const trace = await jobs(resetDemo, { occurrence: LATER });
  expect(trace.executions[0]?.outcome).toBe('completed');

  expect(await db.posts.where({ id: visitorPost.id }).one()).toBeNull();
  // The regression this pins: the purge used to delete the seeded posts too and rely on the replay
  // to restore them, which a soft-delete stamp makes impossible — one reset and the feed was empty
  // forever. `posts` is soft-deletable, so "deleted" here means "stamped and unrecoverable".
  expect((await db.posts.limit(50).all()).length).toBe(seededPosts);
  expect(await missingDemoMarkers()).toHaveLength(0);
  expect((await mediaById(ORPHAN))?.state).toBe('pending');
});
