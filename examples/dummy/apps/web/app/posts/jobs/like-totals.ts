// `likeTotalsRefresh`, the posts slice's view refresh — one primitive per file.
//
// `refreshView()` is a job factory over `post_like_totals`, the materialized view of every post's
// like count: recomputed whole, `concurrently` so readers keep the previous rows while it runs.
// The schedule is `tasks/hourly-likes.ts`; the view's own declaration is `@postly/db`'s.

import { postLikeTotals } from '@postly/db';
import { refreshView } from '@ultimat3/jobs';

export const likeTotalsRefresh = refreshView({
  name: 'posts.like-totals',
  view: postLikeTotals,
  concurrently: true,
});
