/**
 * The feed's live query, as the BROWSER can name it.
 *
 * `liveHookFor(liveFeed)` is the typed binding a server module writes, and an island cannot use it:
 * it takes the query VALUE, so importing it drags `app/posts/live.ts` → `repo.ts` → the whole read
 * path into the client bundle. Measured, `Bun.build --target browser` over the old `./hooks.ts`:
 * **698,801 bytes**, against this route's 60 kB budget. So the island subscribes through `useLive`,
 * which takes anything carrying a `name` — the same seam `shared/client.ts` already uses for reads
 * and writes, one layer down: the name crosses, the implementation never does.
 *
 * A rename is still a compile error, which is the whole reason the name is typed rather than
 * written as a bare string: `keyof Api['queries']` is the registry `defineApi` built, and `Api` is
 * imported as a TYPE, so no module edge exists.
 */

import type { Row } from '@ultimat3/realtime';
import type { Api } from '../../api';

/** What `useLive` subscribes under. `defineApi` names a query after its export, so this is it. */
export const LIVE_FEED: keyof Api['queries'] = 'liveFeed';

/**
 * The row as it arrives on the socket — JSON, not the server's row type: `PostSummary.createdAt`
 * is a `Date` on the server and a string on the wire, so a type read off the query's return would
 * describe a value no browser ever holds. Only the fields this island renders are named.
 */
export interface FeedRow extends Row {
  readonly id: string;
  readonly title: string;
  readonly excerpt: string;
  readonly likeCount: number;
}
