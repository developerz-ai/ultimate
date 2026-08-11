// Marking notifications read. A `mutator` rather than an `action` because it must work in a
// tunnel: dismissing a badge is the most offline-tolerant write this app has, and it is naturally
// convergent — "read" is a state, not an increment, so replaying it costs nothing.
//
// `t` comes from @ultimat3/action, not @ultimat3/schema: a mutator file imports one package.

import { actorOf, mutator, t } from '@ultimat3/action';
import { notificationMarkRead } from './policy';
import * as repo from './repo';

/**
 * The local twin's row shape, keyed by the entity's table so the optimistic row and the server row
 * live in one place. `read` is a boolean and NOT the server's `readAt` timestamp: `local` may not
 * read the clock, so it cannot invent one, and a boolean is what makes the second application a
 * no-op.
 */
declare module '@ultimat3/action' {
  interface LocalTables {
    notifications: { readonly id: string; readonly read: boolean };
  }
}

export const markNotificationsRead = mutator({
  input: t.object({ ids: t.array(t.uuid) }),
  output: t.object({ marked: t.number }),
  /**
   * Decides on input alone — and that is forced, not chosen. `MutatorDef`
   * (packages/action/src/mutator.ts:66) declares no `row` loader, so no mutator's policy can ever
   * be handed a row; ownership is enforced by the SCOPE of the write instead, which `server`
   * below passes as the actor's own id. See `policy.ts` for the full reasoning.
   */
  policy: notificationMarkRead,
  mcp: { expose: true, description: "Mark the acting user's notifications as read" },
  idempotent: true,
  /**
   * Convergent, not incremental. `local` is replayed on every rebase, so applying it N times has
   * to equal applying it once: `read: true` is idempotent, whereas the unread badge's obvious
   * spelling — `unread: count - 1` — would subtract once per replay and show a negative count on a
   * device that drained a queue twice. The count is DERIVED from these booleans, never stored.
   *
   * No clock and no randomness for the same reason: a `Date.now()` here would produce a different
   * row on every replay, and the rebase would never converge.
   */
  local(tx, { ids }) {
    for (const id of ids) {
      tx.notifications.update(id, (row) => (row.read ? {} : { read: true }));
    }
  },
  /**
   * The authoritative half converges the same way: `repo.markRead` leaves a row that already
   * carries a `readAt` untouched, so replaying the mutation server-side is a no-op too and the two
   * halves agree about what "already read" means.
   *
   * `marked` is what the write actually touched, so a batch naming a stranger's notification comes
   * back short. It never comes back with somebody else's row marked, and it never says whose id
   * was rejected — a count is the most a caller may learn about rows that are not theirs.
   */
  async server(ctx, { ids }) {
    // `notificationMarkRead` refused a null actor before this ran (`can()` answers
    // X_UNAUTHENTICATED for one), so this is a real signed-in user.
    const rows = await repo.markRead(actorOf(ctx)?.id ?? '', ids, ctx.now());
    return { marked: rows.length };
  },
  conflict: 'server-wins',
});
