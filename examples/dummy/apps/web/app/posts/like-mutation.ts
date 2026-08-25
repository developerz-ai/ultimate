/**
 * `likePost`, as the BROWSER can name it — the same seam `app/feed/live.ts` is for `liveFeed`.
 *
 * An island cannot import `./mutator.ts`: the declaration reaches `@ultimat3/action`, the policy,
 * `@postly/db`'s tag table and through it the Postgres client, none of which belong in a chunk a
 * browser downloads. `useMutation` takes anything carrying a `name`, so the name crosses and the
 * declaration never does.
 *
 * A rename is still a compile error, which is why the name is typed rather than written as a bare
 * string: a mutator IS an action, so `defineApi` registers it in `Api['actions']` under its export
 * name, and `Api` is imported as a TYPE — no module edge exists.
 *
 * No `local` twin here, and that is the honest shape rather than an omission: the optimistic
 * update is replayed against the durable client store, and this app configures none
 * (`app/posts/live.ts` — `persist: true` over OPFS SQLite has not shipped), so a twin declared
 * here would be a second copy of `mutator.ts`'s that nothing ever calls.
 */

import type { MutatorLike } from '@ultimat3/realtime';
import type { Api } from '../../api';

/** What `useMutation` queues under. `defineApi` names a mutator after its export, so this is it. */
export const LIKE_POST: MutatorLike = { name: 'likePost' satisfies keyof Api['actions'] };
