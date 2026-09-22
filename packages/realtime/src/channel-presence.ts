// Presence as a channel EVENT, not a frame kind of its own: joining a channel declared with
// `events: true` joins its presence set, and a roster change is one `events` frame on that topic.
// Browser-safe — the client reads the same shape back out with `readPresence`.

import { isJsonObject, type JsonObject } from './json';
import { FRAME_LIMITS, type PresenceMember } from './sync-protocol';

export type PresenceOp = 'join' | 'leave' | 'update' | 'sync';

const OPS: readonly PresenceOp[] = ['join', 'leave', 'update', 'sync'];

/** The event payload: `{ presence, members, total? }`. `total` belongs to a full `sync` set only. */
export interface PresenceEvent {
  readonly presence: PresenceOp;
  readonly members: readonly PresenceMember[];
  /** Members in the whole set behind a capped `sync`; never on a delta. */
  readonly total?: number;
}

export function presenceEvent(
  op: PresenceOp,
  members: readonly PresenceMember[],
  total?: number,
): JsonObject {
  const base: JsonObject = {
    presence: op,
    members: members.map((m) => ({
      id: m.id,
      actorId: m.actorId,
      meta: m.meta,
      updatedAt: m.updatedAt,
    })),
  };
  return total === undefined ? base : { ...base, total };
}

/**
 * The presence payload of an `events` frame, or `null` when the event is not one — an app's own
 * events share the channel. Refuses rather than repairs: a malformed roster is `null`, never a
 * partial one, and a list past `FRAME_LIMITS.members` is refused like any oversized frame field.
 */
export function readPresence(event: JsonObject): PresenceEvent | null {
  const op = event['presence'];
  const members = event['members'];
  if (typeof op !== 'string' || !OPS.includes(op as PresenceOp)) return null;
  if (!Array.isArray(members) || members.length > FRAME_LIMITS.members) return null;
  const parsed: PresenceMember[] = [];
  for (const value of members) {
    const one = memberOf(value);
    if (one === null) return null;
    parsed.push(one);
  }
  const total = event['total'];
  const base = { presence: op as PresenceOp, members: parsed };
  if (total === undefined) return base;
  // A count a UI would render: anything but a whole non-negative number is a malformed roster.
  return typeof total === 'number' && Number.isInteger(total) && total >= 0
    ? { ...base, total }
    : null;
}

function memberOf(value: unknown): PresenceMember | null {
  if (!isJsonObject(value)) return null;
  const { id, actorId, meta, updatedAt } = value;
  if (typeof id !== 'string' || typeof updatedAt !== 'number') return null;
  if (actorId !== null && typeof actorId !== 'string') return null;
  return { id, actorId, meta: isJsonObject(meta) ? meta : {}, updatedAt };
}
