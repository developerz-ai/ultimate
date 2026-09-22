// What a RECEIVED frame does to client state — the mirror of `sync-node.ts`'s inbound handler,
// and the only inbound surface `client.ts` exposes. `ClientFrameTarget` is the point: it names
// every piece of the client a frame may touch, so the blast radius of a new frame kind is a
// reviewable list rather than "whatever the router could reach through `this`".

import type { ChannelBook } from './client-channels';
import { CLOSE } from './close-codes';
import { advance } from './cursor';
import type { Registration, RowWindows } from './live-rows';
import type { Frame } from './sync-protocol';

/** Declared with the window it projects; re-exported here because the router is what writes it. */
export type { LiveState, Registration } from './live-rows';

/**
 * The code a `reconnect` frame closes with: `CLOSE.drain`, the same number the node uses for a
 * drain it closes itself, so a log reads one code for one event whichever side closed first. A
 * browser refuses 1001 from script (`InvalidAccessError`), which is why it is not that.
 */
export const RECONNECT_CODE = CLOSE.drain;

/**
 * Everything an inbound frame is allowed to reach. Narrow on purpose — a router that took the
 * client itself could touch the reconnect timer, the socket and the outbound path, none of which
 * a received frame has any business writing. There is no write path here at all: the socket is
 * read-only, and a client write is an HTTP call (`useMutation`).
 */
export interface ClientFrameTarget {
  registration(sid: string): Registration | undefined;
  /** The projection every live window renders through. Rows live in the store, never on a frame. */
  readonly windows: RowWindows;
  /** The declared channels this client holds: their cursors, their handlers, their catch-up. */
  readonly channels: ChannelBook;
  /** The client's clock. A cursor carries `at`, and nothing here may read `Date.now()`. */
  now(): number;
  /** A newer build is live; the app decides when to reload. */
  setUpdate(buildId: string | null): void;
  /** The node assigned this socket its own delay before closing it. */
  scheduleReconnect(afterMs: number | null): void;
  closeSocket(code: number, reason: string): void;
  /** Where a refusal that names nothing this client holds is reported. */
  report(error: unknown): void;
}

export function applyFrame(frame: Frame, target: ClientFrameTarget): void {
  switch (frame.type) {
    case 'snapshot': {
      const registration = target.registration(frame.sid);
      if (!registration) return;
      // State first: the window notifies once, after it has moved, and a reader must see `live`
      // beside the rows it is handed. The record type is the server's — a browser cannot derive it.
      registration.cursor = frame.cursor;
      registration.state = 'live';
      registration.error = undefined;
      target.windows.snapshot(registration, frame.entity ?? null, frame.rows, frame.keys);
      return;
    }
    case 'patch': {
      const registration = target.registration(frame.sid);
      if (registration) {
        // The cursor moves with the patches, not only with a snapshot. Left behind, `cursor.at`
        // froze at the last snapshot and `shouldResnapshot`'s lag check answered "re-snapshot" for
        // every client connected longer than `maxLagMs` — the delta resume the retained change
        // window exists for, dead exactly during the deploy storm it was built for. An empty lsn
        // is a tier-1 channel frame's, so it never rewinds one.
        if (registration.cursor && frame.lsn !== '') {
          const next = advance(registration.cursor, frame.patches, frame.lsn, target.now());
          registration.cursor = next;
        }
        registration.state = 'live';
        target.windows.patch(registration, frame.patches);
        return;
      }
      // A patch names a live registration or nothing: a channel's rows ride `records` frames.
      return;
    }
    case 'ack': {
      // The socket carries no writes, so an `ack` is only ever a refusal: of a subscription (its
      // `ref` is the sid) or of a frame the node could not read at all (its `ref` is the socket).
      if (frame.error === null) return;
      const registration = target.registration(frame.ref);
      if (registration === undefined) {
        if (!target.channels.refused(frame.ref, frame.error)) target.report(frame.error);
        return;
      }
      registration.state = 'failed';
      registration.error = frame.error;
      registration.notify();
      return;
    }
    case 'reconnect': {
      // Order is load-bearing: arming first is what makes the close this triggers keep the delay
      // the node assigned to *this* socket instead of falling back to a local backoff.
      target.scheduleReconnect(frame.afterMs);
      target.closeSocket(RECONNECT_CODE, frame.reason);
      return;
    }
    case 'update-available': {
      target.setUpdate(frame.buildId);
      return;
    }
    case 'records':
      // The channel's cursor decides new from duplicate, and a new epoch re-reads the channel;
      // the records go to the store and nowhere else.
      target.channels.records(frame);
      return;
    case 'events':
      target.channels.event(frame);
      return;
    case 'replay-gap':
      target.channels.gap(frame);
      return;
    case 'hello':
    case 'subscribe':
      // Client-authored frames: never received. Ignored rather than thrown, so a future
      // bidirectional use of the same kind cannot break an old client.
      return;
  }
}
