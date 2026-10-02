// One responsibility: remember what the wire did, so a call that is never answered can say WHY —
// its target went away, frames arrived that nothing could parse, or the target simply stayed
// silent. The connection (`cdp-connection.ts`) feeds every frame in; `CdpTimeoutError` reads it out.

import type { CdpTargetGone, CdpTimeoutObservation } from './cdp-errors';

/** How many of the latest frames a timeout quotes. Bounded: a busy page sends thousands. */
export const LAST_FRAMES = 8;

/** Where the wire stood when a call was sent — what "since the call" is measured from. */
export interface WireMark {
  readonly arrived: number;
  readonly dropped: number;
  readonly navigations: number;
}

export interface WireWatch {
  /** One frame that parsed: a reply or an event. */
  frame(frame: Record<string, unknown>): void;
  /** One frame nothing could parse. It has no `id`, so no call can be failed with it — only counted. */
  drop(): void;
  mark(sessionId: string | undefined): WireMark;
  /** What happened between `mark` and now, for the call sent on `sessionId`. */
  observe(mark: WireMark, sessionId: string | undefined, open: boolean): CdpTimeoutObservation;
}

const text = (from: unknown, key: string): string | undefined => {
  const value =
    typeof from === 'object' && from !== null ? (from as Record<string, unknown>)[key] : undefined;
  return typeof value === 'string' ? value : undefined;
};

export function wireWatch(): WireWatch {
  let arrived = 0;
  let dropped = 0;
  const last: string[] = [];
  const targetOf = new Map<string, string>(); // sessionId → targetId
  const gone = new Map<string, CdpTargetGone>(); // sessionId → how it went
  const navigations = new Map<string, number>(); // sessionId → main-frame navigations

  const goneTarget = (targetId: string | undefined, how: CdpTargetGone): void => {
    for (const [session, target] of targetOf) if (target === targetId) gone.set(session, how);
  };

  /** The few events that say a session can no longer answer, or that its page was replaced. */
  const track = (method: string, session: string | undefined, params: unknown): void => {
    if (method === 'Target.attachedToTarget') {
      const attached = text(params, 'sessionId');
      const target = text(
        (params as Record<string, unknown> | undefined)?.['targetInfo'],
        'targetId',
      );
      if (attached !== undefined && target !== undefined) targetOf.set(attached, target);
    } else if (method === 'Target.detachedFromTarget') {
      const detached = text(params, 'sessionId');
      if (detached !== undefined) gone.set(detached, 'detached');
    } else if (method === 'Target.targetDestroyed') {
      goneTarget(text(params, 'targetId'), 'destroyed');
    } else if (method === 'Target.targetCrashed') {
      goneTarget(text(params, 'targetId'), 'crashed');
    } else if (method === 'Inspector.targetCrashed' && session !== undefined) {
      gone.set(session, 'crashed');
    } else if (method === 'Page.frameNavigated' && session !== undefined) {
      const frame = (params as Record<string, unknown> | undefined)?.['frame'];
      // A frame with a parent is an iframe: the document the call was sent to is still there.
      if (text(frame, 'parentId') === undefined) {
        navigations.set(session, (navigations.get(session) ?? 0) + 1);
      }
    }
  };

  const note = (label: string): void => {
    last.push(label);
    if (last.length > LAST_FRAMES) last.shift();
  };

  return {
    frame(frame): void {
      arrived += 1;
      const session = text(frame, 'sessionId');
      const id = frame['id'];
      const method = text(frame, 'method');
      if (typeof id === 'number') note(`reply ${String(id)}`);
      else if (method === undefined) note('a frame with neither an id nor a method');
      else {
        note(session === undefined ? method : `${method} @${session}`);
        track(method, session, frame['params']);
      }
    },
    drop(): void {
      dropped += 1;
    },
    mark: (sessionId) => ({
      arrived,
      dropped,
      navigations: sessionId === undefined ? 0 : (navigations.get(sessionId) ?? 0),
    }),
    observe(mark, sessionId, open): CdpTimeoutObservation {
      const since = arrived - mark.arrived;
      return {
        sessionId: sessionId ?? null,
        framesArrived: since,
        // Only frames that arrived AFTER the call: an older one says nothing about its reply.
        lastFrames: since === 0 ? [] : last.slice(-Math.min(since, LAST_FRAMES)),
        framesDropped: dropped - mark.dropped,
        transportOpen: open,
        targetGone: sessionId === undefined ? null : (gone.get(sessionId) ?? null),
        navigations:
          sessionId === undefined ? 0 : (navigations.get(sessionId) ?? 0) - mark.navigations,
      };
    },
  };
}
