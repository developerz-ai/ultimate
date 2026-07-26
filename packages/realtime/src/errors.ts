// Realtime's X_* codes. Every throw in this package goes through one of these classes so
// the same string renders in the terminal, the browser overlay, and `--json`.

import { UltimateError } from '@ultimat3/core';

export type RealtimeErrorCode =
  | 'X_TOPIC_FORBIDDEN'
  | 'X_SUBSCRIPTION_LIMIT'
  | 'X_PROTOCOL_VERSION'
  | 'X_CURSOR_STALE'
  | 'X_REBASE_CONFLICT'
  | 'X_TRANSPORT_UNAVAILABLE'
  | 'X_NOT_IMPLEMENTED';

const DOCS_BASE = 'https://ultimate.dev/errors/';

/** Base for every realtime error: fills `docs` from the code so no call site can forget it. */
export class RealtimeError extends UltimateError {
  constructor(opts: { code: RealtimeErrorCode; cause: string; fix: string }) {
    super({
      code: opts.code,
      cause: opts.cause,
      fix: opts.fix,
      docs: `${DOCS_BASE}${opts.code}`,
    });
  }
}

/** Subscribe (or an actor change) denied by the topic's policy. Never leaks the topic's data. */
export class TopicForbiddenError extends RealtimeError {
  constructor(args: { topic: string; actorId: string | null; reason: string }) {
    super({
      code: 'X_TOPIC_FORBIDDEN',
      cause: `actor ${args.actorId ?? '<anonymous>'} may not subscribe to "${args.topic}": ${args.reason}`,
      fix: `declare a guard for this topic: hub.guard('${args.topic}', ({ actor }) => ...)`,
    });
  }
}

/** Load shedding, not a crash: a socket or tenant asked for more subscriptions than the cap. */
export class SubscriptionLimitError extends RealtimeError {
  constructor(args: { scope: 'socket' | 'tenant'; id: string; limit: number }) {
    super({
      code: 'X_SUBSCRIPTION_LIMIT',
      cause: `${args.scope} ${args.id} reached the subscription cap of ${args.limit}`,
      fix: `raise realtime.limits.${args.scope === 'socket' ? 'perSocket' : 'perTenant'} in app.config.ts, or unsubscribe unused live queries`,
    });
  }
}

/**
 * Client and server disagree on the wire format — a version mismatch or a malformed frame.
 * Both are the same class of bug (a peer speaking a shape we do not have), so both get one code.
 */
export class ProtocolVersionError extends RealtimeError {
  constructor(args: { got: unknown; expected: number; detail?: string }) {
    super({
      code: 'X_PROTOCOL_VERSION',
      cause:
        args.detail ??
        `frame protocol version ${String(args.got)} is not the server version ${args.expected}`,
      fix: 'x build && redeploy the client; the sync node sends `update-available` before it drains',
    });
  }
}

/** A resume cursor cannot be honoured and no snapshot path was supplied. */
export class CursorStaleError extends RealtimeError {
  constructor(args: { qid: string; lsn: string; reason: string }) {
    super({
      code: 'X_CURSOR_STALE',
      cause: `cursor for query ${args.qid} at lsn ${args.lsn} cannot be resumed: ${args.reason}`,
      fix: 'pass `snapshot` to resumeFrom() so the fallback path can re-snapshot instead of failing',
    });
  }
}

/** A rebase could not be resolved: `custom(merge)` returned nothing, or the base row vanished. */
export class RebaseConflictError extends RealtimeError {
  constructor(args: { key: string; entity: string; reason: string }) {
    super({
      code: 'X_REBASE_CONFLICT',
      cause: `mutation ${args.key} on ${args.entity} could not be rebased: ${args.reason}`,
      fix: "set conflict: 'server-wins' on the mutator, or return a row from custom(merge)",
    });
  }
}

/** The fanout bus is down. `sync` nodes are stateless, so this is always recoverable. */
export class TransportUnavailableError extends RealtimeError {
  constructor(args: { transport: string; reason: string }) {
    super({
      code: 'X_TRANSPORT_UNAVAILABLE',
      cause: `transport "${args.transport}" is unavailable: ${args.reason}`,
      fix: 'x doctor transport — check REALTIME_TRANSPORT_URL and that the bus is reachable',
    });
  }
}

/** Deep infrastructure that is interface-complete but not wired. Carries the exact next step. */
export class NotImplementedError extends RealtimeError {
  constructor(args: { what: string; fix: string }) {
    super({
      code: 'X_NOT_IMPLEMENTED',
      cause: `${args.what} is interface-complete but not implemented in this build`,
      fix: args.fix,
    });
  }
}
