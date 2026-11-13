// job — `resetDemo`, driven through a real worker: the refusal that decides whether this job may
// exist at all, and the purge that must leave the seeded graph standing. Runs under the `job` step.

import { afterAll, beforeEach, expect, test } from 'bun:test';
import { db, driver, seedDemo } from '@social-media-clone/db';
import { seedId } from '@ultimat3/entity';
import { type RunJobs, testJobs } from '@ultimat3/testing';
import { mediaById, missingDemoMarkers } from '../repo';
import { resetDemo } from './reset-demo';

/** The seed's deliberate orphan: a reset re-seeds, so it must come back `pending`. */
const ORPHAN = seedId('media:orphan');
const CUTOFF = '2026-04-01T00:00:00.000Z';
const LATER = '2026-05-01T00:00:00.000Z';

let jobs: RunJobs;

beforeEach(async () => {
  // Emptied, THEN re-seeded: a replay is `on conflict do nothing` (packages/entity/src/seed.ts:274),
  // so it restores a row that is gone and never a value a test changed — `media:orphan` swept to
  // `orphan` stays `orphan` for every test after it. `reset?.()` is the framework's test seam for
  // exactly this, and it is the only thing that makes these tests order-independent.
  driver.reset?.();
  await seedDemo();
  await jobs?.[Symbol.asyncDispose]();
  jobs = await testJobs();
});

afterAll(async () => {
  await jobs?.[Symbol.asyncDispose]();
});

test('the reset carries no tenant: it owns every row, and no entity here has one', () => {
  expect(resetDemo.tenantFor({ occurrence: CUTOFF })).toBeUndefined();
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
