// A socket whose actor changed mid-connection: every subscription it holds re-decided under the
// new actor, re-seated onto the new tenant's window, and — new principal's cap first — refused
// rather than carried past a ceiling. Split from `live-query.ts` at its size ceiling: the registry
// owns the entry table, this owns what a re-authorization does to one socket's subscriptions.

import { queryHash } from '@ultimat3/query';
import { isPolicyDenial } from './errors';
import type { LiveSubscription } from './live-contract';
import { refuseSubscription } from './live-refusal';
import type { SubscribeArgs } from './live-spend';
import { liveTenantOf, windowId } from './live-tenant';
import type { SyncSocket } from './socket';
import type { SubscriberGate } from './subscriber-gate';
import type { SubscriptionBook } from './subscription-book';
import type { Frame } from './sync-protocol';

/** What a re-authorization reaches on the registry, and nothing else. */
export interface ReauthDeps {
  readonly book: SubscriptionBook;
  readonly gate: SubscriberGate;
  unsubscribe(socketId: string, sid: string): void;
  /** Subscribe again under the same sid, uncharged — a re-seat is not a new subscription. */
  resubscribe(args: SubscribeArgs): Promise<{ readonly frame: Frame }>;
}

/**
 * Actor changed mid-connection (login, logout, role change): re-run subscribe-time authz and drop
 * what is no longer allowed. Survivors are marked desynced so the next flush re-snapshots them
 * under the new actor's row policy. Returns the sids that were dropped — a denial and nothing
 * else, so a caller may tell the client "you may no longer see this" and be right.
 *
 * A survivor whose actor now belongs to ANOTHER tenant cannot stay where it is: its window is the
 * old org's. It is re-seated — dropped, subscribed again under the new tenant, and sent that
 * window's snapshot under the same sid — or, when that cannot complete, refused on the socket
 * under the sid (`refuseSubscription`), never kept on the old org's window.
 */
export async function reauthorizeSocket(
  deps: ReauthDeps,
  socket: SyncSocket,
): Promise<readonly string[]> {
  const dropped: string[] = [];
  // The actor changed, so what tenant this socket's subscriptions count against may have too.
  // Told here rather than derived per lookup: the per-tenant cap is an index now, and an index
  // nobody updates is a count that drifts from the book for the rest of the process.
  refuseOverflow(deps, socket);
  deps.book.retenant(socket);
  for (const subscription of deps.book.ofSocket(socket.id)) {
    let failed: { readonly error: unknown } | undefined;
    try {
      await subscription.definition.authorize?.({
        actor: socket.actor,
        input: subscription.input,
      });
    } catch (error) {
      if (isPolicyDenial(error)) {
        deps.unsubscribe(socket.id, subscription.sid);
        // Said under the sid, as a refused subscribe is: unsaid, the client kept the rows on
        // screen in state `live` for a subscription this node no longer serves.
        refuseSubscription(socket, subscription.sid, error);
        dropped.push(subscription.sid);
        continue;
      }
      // Not a decision — the gate never reached one. Destroying the subscription would report a
      // database timeout as a revoked grant, and a client does not resubscribe to a denial. It
      // survives, desynced: nothing is delivered from the window built under the old actor, and
      // the row gate still decides every row under the new one, from the same policy `authorize`
      // consults. The failure is counted and reported rather than silently absorbed.
      deps.gate.failedAuthorize(
        subscription.qid,
        { sid: subscription.sid, actor: socket.actor },
        error,
      );
      failed = { error };
    }
    if (await reseat(deps, socket, subscription, failed)) continue;
    socket.markDesynced(subscription.sid);
  }
  return dropped;
}

/**
 * Move one subscription onto its actor's CURRENT tenant's window. `false` when it is already
 * there. A re-seat that cannot complete leaves the subscription dropped — never attached to the
 * window of an org its actor has left — and REFUSED on the socket under its sid, the frame a
 * refused subscribe gets, so the client's window renders `failed` instead of going quiet.
 *
 * `failed` is the `authorize` this pass already saw fail: it is not asked again — the store that
 * just timed out is the one `subscribe` would ask — and it is not counted twice.
 */
async function reseat(
  deps: ReauthDeps,
  socket: SyncSocket,
  subscription: LiveSubscription,
  failed: { readonly error: unknown } | undefined,
): Promise<boolean> {
  const { sid, input, definition } = subscription;
  const wanted = windowId(queryHash(definition.name, input), liveTenantOf(socket.actor));
  if (wanted === subscription.qid) return false;
  deps.unsubscribe(socket.id, sid);
  if (failed !== undefined) {
    refuseSubscription(socket, sid, failed.error);
    return true;
  }
  try {
    const { frame } = await deps.resubscribe({ socket, name: definition.name, input, sid });
    if (!socket.send(frame)) socket.markDesynced(sid);
  } catch (error) {
    deps.gate.failedAuthorize(wanted, { sid, actor: socket.actor }, error);
    refuseSubscription(socket, sid, error);
  }
  return true;
}

/**
 * The subscriptions the socket's NEW tenant or actor has no room for, refused under their sids
 * before the move — so the move never carries a key past its cap, and filling an address then
 * signing in cannot be repeated to stack one actor past it. The newest go first: the client's
 * oldest windows are the ones it has been rendering longest. Not a denial, so not in `dropped`.
 */
function refuseOverflow(deps: ReauthDeps, socket: SyncSocket): void {
  const overflow = deps.book.overflowOnRekey(socket);
  if (overflow === null) return;
  for (const subscription of deps.book.ofSocket(socket.id).slice(-overflow.excess)) {
    deps.unsubscribe(socket.id, subscription.sid);
    refuseSubscription(socket, subscription.sid, overflow.error);
  }
}
