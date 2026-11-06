/**
 * unit — `posts.daily-likes` against the app's migrated database: the dev seed's likes become one
 * row per UTC day, a like that lands late inside the two-day lookback moves its day's count, and
 * a second run over the same likes writes the same rows.
 */

import { dailyLikes, db } from '@postly/db';
import { migratedDatabase } from '@ultimat3/cli';
import { ctxOf, frozenClock, runWithContext, serviceActor } from '@ultimat3/core';
import { setDbClient } from '@ultimat3/db';
import { memoryStepStore, stepRunner } from '@ultimat3/jobs';
import { afterAll, beforeAll, expect, reusableDatabase, test } from '@ultimat3/testing';
import { dailyLikesRollup } from './daily-likes';

// A template restore is ~0.5 s; its first build (initdb plus every migration) is what this bounds.
const BOOT_MS = 120_000;
/** A day after the seed's last like on `post:tenancy`, so both of its days are inside lookback. */
const NOW = new Date('2026-03-04T06:00:00.000Z');

const workerDatabase = reusableDatabase(() => migratedDatabase({ root: import.meta.dir }));

beforeAll(async () => {
  setDbClient(await workerDatabase());
}, BOOT_MS);
afterAll(() => setDbClient(undefined));

let runs = 0;
const run = () => {
  runs += 1;
  const runId = `daily-likes-${runs}`;
  const ctx = ctxOf({
    role: 'worker',
    actor: serviceActor({ id: 'worker' }),
    clock: frozenClock(NOW),
  });
  return runWithContext(ctx, () =>
    dailyLikesRollup.run({
      input: {},
      step: stepRunner({ runId, jobName: dailyLikesRollup.name, store: memoryStepStore() }).step,
      ctx,
      attempt: 1,
      finalAttempt: true,
      progress: () => undefined,
      jobId: runId,
      runId,
    }),
  );
};

const stored = async () =>
  (await db.dailyLikes.orderBy('day').all()).map((row) => [row.day.toISOString(), row.likes]);

test('the window becomes one row per UTC day, a late like moves its day, a re-run is a no-op', async ({
  seed,
}) => {
  const { post, other, ada, bruno } = await seed('dev').pick({
    post: 'post:tenancy',
    other: 'post:timezones',
    ada: 'member:ada',
    bruno: 'member:bruno',
  });
  expect(dailyLikesRollup.name).toBe('posts.daily-likes');
  expect(dailyLikes.$primaryKey).toEqual(['day']);

  // Bruno's like on another post at 03:00 on 2 March: before `now - lookback` (06:00), inside
  // the day it falls in — the window opens at that day's midnight, so the bucket counts it.
  await db.likes.insert({
    orgId: other.orgId,
    postId: other.id,
    memberId: bruno.id,
    createdAt: new Date('2026-03-02T03:00:00.000Z'),
  });
  // The seed's likes: 2 March 14:00 and 3 March 01:10 on this post, 9 March on the other. The
  // window is bounded below only, so the dated-ahead seed row counts as landed.
  expect(await run()).toMatchObject({ since: '2026-03-02T00:00:00.000Z', rows: 3 });
  expect(await stored()).toEqual([
    ['2026-03-02T00:00:00.000Z', 2],
    ['2026-03-03T00:00:00.000Z', 1],
    ['2026-03-09T00:00:00.000Z', 1],
  ]);

  // Ada's like, written now but dated inside the window: an offline queue replayed late.
  await db.likes.insert({
    orgId: post.orgId,
    postId: post.id,
    memberId: ada.id,
    createdAt: new Date('2026-03-03T20:00:00.000Z'),
  });
  await run();
  const after = await stored();
  expect(after).toEqual([
    ['2026-03-02T00:00:00.000Z', 2],
    ['2026-03-03T00:00:00.000Z', 2],
    ['2026-03-09T00:00:00.000Z', 1],
  ]);

  // Idempotent by construction: the same likes, the same rows, no second row per day.
  await run();
  expect(await stored()).toEqual(after);
});
