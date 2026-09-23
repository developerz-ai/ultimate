/**
 * The posts feature's realtime channel, server half. `channel(ORG_POSTS, …)` registers on import —
 * `api/index.ts` imports this module — and from then on every committed `posts` row reaches the
 * members of its org's topic as a record, derived from the change feed: no write names a channel.
 *
 * `feedRead` is the subscribe decision, with the params as input: the same rule the feed read
 * evaluates, so a member who may read the feed may hold its records and nobody else can.
 */

import { posts } from '@postly/db';
import { channel } from '@ultimat3/realtime';
import { ORG_POSTS } from './channel-ref';
import { feedRead } from './policy';

export const orgPosts = channel(ORG_POSTS, { records: [posts], policy: feedRead });
