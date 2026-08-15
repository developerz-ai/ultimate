/**
 * The feed's live subscription, bound once. `liveHookFor` is the typed projection of a declared
 * `query({ live: true })`: the input keys and the row shape come off `liveFeed` itself, so a
 * component reads `post.likeCount` as a number rather than off an untyped wire row, and a wrong
 * input key is a compile error here instead of a subscription that answers nothing.
 *
 * A module-level binding, not a call inside the component: it runs at import, which is before
 * `registerQueries()` stamps the query's name — `useLive` reads that name per subscription.
 */

import { liveHookFor } from '@ultimat3/realtime';
import { liveFeed } from '../posts/live';

export const useLiveFeed = liveHookFor(liveFeed);
