// Realtime's X_* codes. Every throw in this package goes through one of these classes so
// the same string renders in the terminal, the browser overlay, and `--json`.

import { registerErrorCodes, UltimateError } from '@ultimat3/core';

/** Codes this package declares and owns. */
export const REALTIME_OWNED_ERROR_CODES = [
  'X_TOPIC_FORBIDDEN',
  'X_SUBSCRIPTION_LIMIT',
  'X_PROTOCOL_VERSION',
  'X_CURSOR_STALE',
  'X_REBASE_CONFLICT',
  'X_TRANSPORT_UNAVAILABLE',
  'X_TRANSPORT_PROTOCOL',
  'X_REPLICATION_PROTOCOL',
  'X_REPLICATION_FAILED',
  'X_REPLICATOR_SLOT_HELD',
  'X_LIVE_CLIENT_MISSING',
] as const;

/**
 * `X_NOT_IMPLEMENTED` is `@ultimat3/core`'s, and `X_FORBIDDEN` — thrown by the surface denials this
 * package renders — is `@ultimat3/policy`'s. Neither is titled here: the owner writes the one title
 * every surface renders, and a copy kept alongside it is a copy that goes stale unnoticed.
 */
export const REALTIME_BORROWED_ERROR_CODES = ['X_NOT_IMPLEMENTED'] as const;

/** Every code realtime can throw through `RealtimeError`: the ones it owns plus the borrowed one. */
export const REALTIME_ERROR_CODES = [
  ...REALTIME_OWNED_ERROR_CODES,
  ...REALTIME_BORROWED_ERROR_CODES,
] as const;

export type RealtimeOwnedErrorCode = (typeof REALTIME_OWNED_ERROR_CODES)[number];
export type RealtimeErrorCode = (typeof REALTIME_ERROR_CODES)[number];

export const REALTIME_ERROR_TITLES: Readonly<Record<RealtimeOwnedErrorCode, string>> = {
  X_TOPIC_FORBIDDEN: 'the actor may not subscribe to this topic',
  X_SUBSCRIPTION_LIMIT: 'socket or tenant hit its subscription cap',
  X_PROTOCOL_VERSION: 'client and sync node disagree on the wire protocol',
  X_CURSOR_STALE: 'the resume LSN is outside the change buffer',
  X_REBASE_CONFLICT: 'a local mutation could not be rebased',
  X_TRANSPORT_UNAVAILABLE: 'the fanout bus is unreachable',
  X_TRANSPORT_PROTOCOL: 'the bus does not speak the protocol this build speaks',
  X_REPLICATION_PROTOCOL: 'the WAL stream cannot be decoded',
  X_REPLICATION_FAILED: 'the replication connection was refused',
  X_REPLICATOR_SLOT_HELD: 'another replicator already owns this database',
  X_LIVE_CLIENT_MISSING: 'a realtime hook ran with no LiveClient registered',
};

// One unconditional call, so a second package claiming one of realtime's codes throws
// X_ERROR_CODE_DUPLICATE instead of losing silently to whichever module imported first.
registerErrorCodes(
  Object.fromEntries(
    Object.entries(REALTIME_ERROR_TITLES).map(([code, title]) => [code, { title }]),
  ),
);

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
  constructor(args: { transport: string; reason: string; fix?: string }) {
    super({
      code: 'X_TRANSPORT_UNAVAILABLE',
      cause: `transport "${args.transport}" is unavailable: ${args.reason}`,
      // Names the key `selectTransport` actually reads, and a command that actually exists.
      fix: args.fix ?? 'x doctor — then check NATS_URL points at a reachable nats-server',
    });
  }
}

/**
 * The bytes on the bus socket are not the protocol we speak: an unknown NATS verb, a header block
 * that is not `NATS/1.0`, a JetStream reply in a shape the API never produces. Always a version or
 * configuration mismatch rather than a transient fault, so reconnecting to the same server cannot
 * help — which is exactly why it is a different code from `X_TRANSPORT_UNAVAILABLE`.
 */
export class TransportProtocolError extends RealtimeError {
  constructor(args: { transport: string; stage: string; detail: string; fix?: string }) {
    super({
      code: 'X_TRANSPORT_PROTOCOL',
      cause: `transport "${args.transport}" ${args.stage}: ${args.detail}`,
      fix:
        args.fix ??
        'x doctor transport — the bus must be nats-server >= 2.11 with JetStream enabled (`nats-server -js`)',
    });
  }
}

/**
 * The bytes on the replication socket are not the bytes the protocol allows: a truncated message,
 * an unknown pgoutput tag, an auth method we do not speak. Always a version or configuration
 * mismatch rather than a transient fault, so retrying the same connection cannot help.
 */
export class ReplicationProtocolError extends RealtimeError {
  constructor(args: { stage: string; detail: string; fix?: string }) {
    super({
      code: 'X_REPLICATION_PROTOCOL',
      cause: `postgres replication ${args.stage}: ${args.detail}`,
      fix:
        args.fix ??
        'x doctor db — the server must be postgres >= 14 with a pgoutput publication and wal_level=logical',
    });
  }
}

/**
 * The replication connection itself failed — refused credentials, a slot another process holds,
 * an `ErrorResponse` from the server. The server's own message is passed through verbatim
 * because it names the object that has to change.
 */
export class ReplicationFailedError extends RealtimeError {
  constructor(args: { stage: string; detail: string; fix: string }) {
    super({
      code: 'X_REPLICATION_FAILED',
      cause: `postgres replication ${args.stage} failed: ${args.detail}`,
      fix: args.fix,
    });
  }
}

/**
 * A second replicator found the advisory lock held. Distinct from `X_REPLICATION_FAILED` because
 * nothing is wrong with this process: the database already has its one replicator, and a second
 * one that started anyway would publish every change twice. Terminal for a container whose whole
 * job is that role — the scheduler is the thing that has to change, not the connection.
 */
export class ReplicatorSlotHeldError extends RealtimeError {
  constructor(args: { key: string; holder?: string | undefined }) {
    super({
      code: 'X_REPLICATOR_SLOT_HELD',
      cause:
        `advisory lock ${args.key} is held${args.holder === undefined ? '' : ` by ${args.holder}`}` +
        ' — one database has exactly one replicator',
      fix: 'scale the replicator to 1 per database: kubectl scale deploy/replicator --replicas=1',
    });
  }
}

/**
 * A hook was called before the app entry registered its client. Never a transient fault: the
 * registration is a single call in the entry, so the fix is the call itself rather than a retry.
 */
export class LiveClientMissingError extends RealtimeError {
  constructor(args: { hook: string }) {
    super({
      code: 'X_LIVE_CLIENT_MISSING',
      cause: `${args.hook}() ran before any LiveClient was registered`,
      fix: 'setLiveClient(new LiveClient({ signal: createSignal, connect, buildId })) in the app entry, above the first render',
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
