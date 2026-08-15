// What a RECEIVED frame does to client state — the mirror of `sync-node.ts`'s inbound handler,
// and the only inbound surface `client.ts` exposes. `ClientFrameTarget` is the point: it names
// every piece of the client a frame may touch, so the blast radius of a new frame kind is a
// reviewable list rather than "whatever the router could reach through `this`".

import type { JsonObject, JsonValue } from './json';
import type { Registration, RowWindows } from './live-rows';
import type { LocalStore, TableMap } from './local-store';
import type { OfflineQueue } from './offline-queue';
import { type RebaseLog, reconcile } from './rebase';
import type { Frame, PresenceMember } from './sync-protocol';

/** Declared with the window it projects; re-exported here because the router is what writes it. */
export type { LiveState, Registration } from './live-rows';

/**
 * Everything an inbound frame is allowed to reach. Narrow on purpose — a router that took the
 * client itself could touch the reconnect timer, the socket and the outbound path, none of which
 * a received frame has any business writing.
 */
export interface ClientFrameTarget<T extends TableMap = TableMap> {
  registration(sid: string): Registration | undefined;
  /** The projection every live window renders through. Rows live in its map, never on a frame. */
  readonly windows: RowWindows;
  topicHandlers(topic: string): ReadonlySet<(message: JsonObject) => void> | undefined;
  readonly queue: OfflineQueue | undefined;
  readonly store: LocalStore<T> | undefined;
  readonly log: RebaseLog<T> | undefined;
  /** A newer build is live; the app decides when to reload. */
  setUpdate(buildId: string | null): void;
  /** The node assigned this socket its own delay before closing it. */
  scheduleReconnect(afterMs: number | null): void;
  closeSocket(code: number, reason: string): void;
  notifyQueueChange(): void;
}

/** Presence members cross the topic channel as plain JSON, like every other channel message. */
function memberJson(member: PresenceMember): JsonValue {
  return { id: member.id, actorId: member.actorId, meta: member.meta, updatedAt: member.updatedAt };
}

export function applyFrame<T extends TableMap>(frame: Frame, target: ClientFrameTarget<T>): void {
  switch (frame.type) {
    case 'snapshot': {
      const registration = target.registration(frame.sid);
      if (!registration) return;
      // The entity is the server's, and it is what upgrades this window from its own private scope
      // to the one every other query over the same entity shares.
      target.windows.snapshot(registration, frame.entity ?? null, frame.rows);
      registration.cursor = frame.cursor;
      registration.setCursor(frame.cursor);
      registration.setState('live');
      return;
    }
    case 'patch': {
      const registration = target.registration(frame.sid);
      if (registration) {
        target.windows.patch(registration, frame.patches);
        registration.setState('live');
        return;
      }
      // No registration: it is a tier-1 channel message on `sid = topic`.
      const handlers = target.topicHandlers(frame.sid);
      if (!handlers) return;
      for (const patch of frame.patches) {
        if (patch.row === null) continue;
        for (const handler of handlers) handler(patch.row);
      }
      return;
    }
    case 'ack': {
      const queue = target.queue;
      // `ack`/`fail` mutate the queue synchronously and persist asynchronously; chaining rather
      // than notifying right after the call keeps this correct even if that ordering ever
      // changes, and it still fires exactly once the persisted write actually lands.
      const settled = frame.error ? queue?.fail(frame.ref, frame.error) : queue?.ack(frame.ref);
      void settled?.then(() => target.notifyQueueChange());
      return;
    }
    case 'rebase': {
      const store = target.store;
      const log = target.log;
      if (!store || !log) return;
      // One batch for the whole reconcile — a rollback, server truth and every replayed mutator
      // are one frame's worth of change, so a live window holding those rows renders once.
      store.identity.batch(() => {
        reconcile({
          store,
          log,
          ack: {
            key: frame.key,
            entity: frame.entity,
            id: frame.row?.id ?? frame.key,
            row: frame.row,
          },
        });
      });
      return;
    }
    case 'reconnect': {
      // Order is load-bearing: arming first is what makes the close this triggers keep the delay
      // the node assigned to *this* socket instead of falling back to a local backoff.
      target.scheduleReconnect(frame.afterMs);
      target.closeSocket(1001, frame.reason);
      return;
    }
    case 'update-available': {
      target.setUpdate(frame.buildId);
      return;
    }
    case 'presence': {
      const handlers = target.topicHandlers(frame.topic);
      if (!handlers) return;
      const message: JsonObject = { op: frame.op, members: frame.members.map(memberJson) };
      for (const handler of handlers) handler(message);
      return;
    }
    case 'hello':
    case 'subscribe':
    case 'mutate':
      // Client-authored frames: never received. Ignored rather than thrown, so a future
      // bidirectional use of the same kind cannot break an old client.
      return;
  }
}
