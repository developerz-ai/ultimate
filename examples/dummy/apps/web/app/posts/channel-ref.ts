/**
 * The `org-posts` channel as a BROWSER can hold it: its name, its one param and its catch-up read —
 * no entity, no policy. The server half (`channels.ts`) declares the records and who may join on
 * this same ref, so name and params are written once and an island never bundles `@postly/db`.
 *
 * `Api` is imported as a TYPE, so the query names are compile-checked against the registry
 * `defineApi` built and no module edge reaches a feature's implementation.
 */

import { channelRef } from '@ultimat3/realtime';
import type { Api } from '../../api';

/** The catch-up read: the org's recent posts as whole rows (`live.ts`). */
export const ORG_POSTS_READ: keyof Api['queries'] = 'orgPosts';

/** One post as its whole row — what an island seeds its record from (`live.ts`). */
export const POST_RECORD_READ: keyof Api['queries'] = 'postRecord';

/** `org-posts.<orgId>`: every committed `posts` row of that org reaches its members as a record. */
export const ORG_POSTS = channelRef('org-posts', {
  params: ['orgId'],
  catchUp: { name: ORG_POSTS_READ },
});

/**
 * A `posts` record as the store holds it — JSON off the wire, so instants are strings. Only the
 * fields an island renders are named; `likedByMe` is the optimistic twin's own flag
 * (`like-mutation.ts`), present only while a like of this device's is pending.
 */
export interface PostRecord {
  readonly id: string;
  readonly orgId: string;
  readonly title: string;
  readonly excerpt: string;
  readonly likeCount: number;
  readonly likedByMe?: boolean;
}
