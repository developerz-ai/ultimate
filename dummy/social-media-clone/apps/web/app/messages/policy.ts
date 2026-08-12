// Authorization for chat. One rule, evaluated identically by the page, the action, the live
// subscription, the channel guard and the MCP tool. There is no second door.
//
// Membership IS the authorization fact: a row in `participants` is permission to read the thread.
// Nothing here consults a second grant, because a second grant is a second thing to keep in step.
//
// The predicate decides on `actor.id` and the loaded row ALONE, and reads both off the arguments
// it is handed. `app/posts/policy.ts` needs one thing more — the request-resolved friend and block
// sets — and it reads those off the SAME actor, as facts, for the same reason: a sync node's
// context carries no ambient viewer (`packages/cli/src/dev-roles.ts:151`), and a rule that reached
// for one would allow in a page render and deny for a subscriber.

import { can, definePermissions } from '@ultimat3/policy';

/**
 * Declared rather than assumed: the augmentation narrows `can()` to these strings, so a typo is a
 * build error instead of a rule that silently never matches.
 */
declare module '@ultimat3/policy' {
  interface PermissionRegistry {
    'message:read': true;
    'message:send': true;
  }
}

export const messagePermissions = definePermissions(['message:read', 'message:send']);

/**
 * The row every message rule decides about. Loaded by the SURFACE — an action's `row()`, a page,
 * a channel guard — never fetched inside the rule: a predicate is synchronous because a live query
 * re-evaluates one per subscriber on every change, and an `await` there is a database round trip
 * per row per connected client.
 *
 * Blocks are absent on purpose. A block hides *content* from a stranger; a conversation is a room
 * two people are already standing in, and the fact that answers "may I read this room" is the
 * participants row. Whether blocking should also evict a thread is a friendship decision and
 * belongs to the slice that owns blocks, not to a second copy of the rule here.
 */
export interface ThreadRow {
  readonly conversationId: string;
  /** Everyone in the thread. Order is irrelevant; membership is a set question. */
  readonly participantIds: readonly string[];
}

export const isParticipant = (actorId: string | null, thread: ThreadRow): boolean =>
  actorId !== null && thread.participantIds.includes(actorId);

/**
 * `row === null` is a DENIAL, never a pass. An absent fact is not a satisfied one: treating it as
 * one hands anyone holding `message:read` a way to skip the membership check entirely, by reaching
 * a surface that passes no row — and the live subscribe gate is exactly such a surface
 * (`packages/realtime/src/policy-gate.ts:26` passes `null` unconditionally).
 */
export const threadRead = can<Record<string, never>, ThreadRow>(
  'message:read',
  ({ actor, row }) => row !== null && isParticipant(actor?.id ?? null, row),
);

/** You may only write into a thread you may read. One rule, reused, so the two cannot drift. */
export const messageSend = can<Record<string, never>, ThreadRow>(
  'message:send',
  ({ actor, row }) => row !== null && isParticipant(actor?.id ?? null, row),
);
