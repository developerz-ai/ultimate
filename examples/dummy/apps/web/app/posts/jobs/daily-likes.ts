// `dailyLikesRollup`, the posts slice's rollup — one primitive per file, the layout `x g` writes.
//
// `rollup()` is a job factory, not a ninth primitive: each run re-reads the last two days of
// likes as a daily series and upserts it into `daily_likes` in one write, so a like that lands
// late still counts and a re-run changes nothing. The schedule is `tasks/hourly-likes.ts`.

import { dailyLikes, db } from '@postly/db';
import { serviceActor, withChildContext } from '@ultimat3/core';
import { CROSS_TENANT_SCOPE, crossTenant } from '@ultimat3/entity';
import { rollup } from '@ultimat3/jobs';

/**
 * Who reads every org's likes, and it is not the worker: the rollup declares no tenant because
 * its table is Postly's, not an org's. `crossTenant` refuses an actor without `tenancy:cross`, so
 * the read names itself — the same rule `app/orgs/repo.ts` states for the digest's sweep.
 */
const likeCounter = serviceActor({ id: 'daily-likes-rollup', scopes: [CROSS_TENANT_SCOPE] });

export const dailyLikesRollup = rollup({
  name: 'posts.daily-likes',
  into: dailyLikes,
  table: () => db.dailyLikes,
  key: ['day'],
  // How late a like may arrive and still count: an offline device replays its queue within a day,
  // so two days covers it with a day to spare. Older than that, the bucket is final.
  lookback: '2d',
  // UTC, named: the report is the operator's, and a day in no zone is a day in nobody's. `since`
  // arrives as the first instant of the UTC day holding `now - lookback`, so that day is whole.
  bucket: { unit: 'day', timeZone: 'UTC' },
  tenant: 'none',
  source: ({ since, bucket }) =>
    withChildContext({ actor: likeCounter }, () =>
      crossTenant('the daily likes report counts every org’s likes into one row per day', () =>
        db.likes
          .andWhere('createdAt', 'gte', since)
          .series({ on: 'createdAt', ...bucket, value: 'count' }),
      ),
    ),
  map: (point) => ({ day: point.bucket, likes: point.value }),
});
