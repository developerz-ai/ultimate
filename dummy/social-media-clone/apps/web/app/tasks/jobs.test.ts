// job — the sweep, driven through a real worker rather than by calling `run()` directly. A job's
// execution surface IS the queue: claim, execute, ack, dedupe. Calling the body by hand would test
// a function and claim to have tested a job.

import { afterAll, beforeEach, expect, test } from 'bun:test';
import { seedDemo } from '@social-media-clone/db';
import { seedId } from '@ultimat3/entity';
import { createRunJobs, type RunJobs } from '@ultimat3/testing';
import { resetDemo, sweepOrphanMedia } from './jobs';
import { mediaById, pendingMediaBefore } from './repo';

/** The seed's deliberate orphan, and the attached row that must survive every sweep. */
const ORPHAN = seedId('media:orphan');
const ATTACHED = seedId('media:tenancy-cover');

/** After both seeded uploads (2026-03-01 and 2026-03-02), so the cutoff is not the thing under test. */
const CUTOFF = '2026-04-01T00:00:00.000Z';
const LATER = '2026-05-01T00:00:00.000Z';

let jobs: RunJobs;

beforeEach(async () => {
  // Re-seeded per test: `insert` overwrites by primary key, so this puts `media:orphan` back at
  // `pending` and no test depends on the order the others ran in.
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
