/**
 * The feed's live query, as the BROWSER can name it.
 *
 * `useQuery({ name: LIVE_FEED, live: true }, { orgId })` takes a name and the declaration's
 * live-ness — never the query VALUE: importing `liveFeed` drags `app/posts/live/live-feed.ts` → `repo.ts` →
 * the whole read path into the client bundle. Measured, `Bun.build --target browser` over the old
 * `./hooks.ts`: **698,801 bytes**, against this route's 60 kB budget. The name crosses, the
 * implementation never does — the same seam `shared/client.ts` uses for reads and writes.
 *
 * The rows are RECORDS: the node names their type on the snapshot, so each is the page store's
 * `posts:<id>` — the same object `/posts/{id}`'s islands read and a like there moves.
 *
 * A rename is still a compile error, which is the whole reason the name is typed rather than
 * written as a bare string: `keyof Api['queries']` is the registry `defineApi` built, and `Api` is
 * imported as a TYPE, so no module edge exists.
 */

import type { LiveRow } from '@ultimat3/realtime';
import type { Api } from '../../api';
import type { PostSummary } from '../posts/entity';

/** What `useQuery` subscribes under. `defineApi` names a query after its export, so this is it. */
export const LIVE_FEED: keyof Api['queries'] = 'liveFeed';

/** A value as JSON carries it: an instant is its ISO string, a nullable instant stays nullable. */
type OnTheWire<T> = T extends Date ? string : T;

/** The fields this island renders — named off `PostSummary`, so a renamed column is a type error. */
type RenderedKeys = 'id' | 'title' | 'excerpt' | 'likeCount' | 'publishedAt' | 'createdAt';

/**
 * The row as it arrives on the socket — `liveFeed`'s own `PostSummary`, DERIVED, never restated:
 * `PostSummary.createdAt` is a `Date` on the server and a string on the wire, so the server type as
 * written would describe a value no browser ever holds, and a hand copy (which stood here until
 * 2026-11) would drift from the view the first time a column moved. A type import: no module edge.
 */
export type FeedRow = LiveRow & {
  readonly [K in RenderedKeys]: OnTheWire<PostSummary[K]>;
};
