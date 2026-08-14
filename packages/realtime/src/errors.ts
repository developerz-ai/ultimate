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
  'X_LIVE_ROW_UNIDENTIFIED',
  'X_LIVE_QUERY_UNKNOWN',
  'X_QUERY_NOT_SUBSCRIBABLE',
] as const;

/**
 * `X_NOT_IMPLEMENTED` is `@ultimat3/core`'s, and `X_FORBIDDEN` — thrown by the surface denials this
 * package renders — is `@ultimat3/policy`'s. Neither is titled here: the owner writes the one title
 * every surface renders, and a copy kept alongside it is a copy that goes stale unnoticed.
 */
export const REALTIME_BORROWED_ERROR_CODES = ['X_NOT_IMPLEMENTED'] as const;

/**
 * The two codes an authz **decision** carries. Everything else a gate throws — a rule that reached
 * for a row and timed out, a predicate with a typo in it — is a failure to reach a decision at all,
 * and reading one as "denied" publishes an outage as a permission change: rows leave the screen,
 * `live.rows_denied` ticks up, and nothing ever pages anyone.
 */
export const POLICY_DENIAL_CODES: ReadonlySet<string> = new Set([
  'X_FORBIDDEN',
  'X_UNAUTHENTICATED',
]);

/**
 * The sync protocol's answer to "which of these is a 4xx". A denied topic, a subscription cap, a
 * skewed protocol version and a cursor that fell out of the buffer are all conditions the CLIENT
 * caused and the ack frame already explains — so an error monitor that held them would be a log
 * nobody reads. Everything else, including an accidental `TypeError`, is this node's fault.
 * Kept beside the code list so the two cannot drift, and it spreads the denial codes rather than
 * respelling them: a denial is always the client's own condition.
 */
export const REALTIME_CLIENT_FAULT_CODES: ReadonlySet<string> = new Set([
  ...POLICY_DENIAL_CODES,
  'X_TOPIC_FORBIDDEN',
  'X_SUBSCRIPTION_LIMIT',
  'X_PROTOCOL_VERSION',
  'X_LIVE_QUERY_UNKNOWN',
  'X_CURSOR_STALE',
  'X_REBASE_CONFLICT',
]);

/** True when the client is the one who can fix it, so the node must not page anyone about it. */
export function isClientFault(error: unknown): boolean {
  return REALTIME_CLIENT_FAULT_CODES.has(codeOf(error) ?? '');
}

/**
 * True when a gate **decided** against the actor, false when it never got that far. The gates take
 * arbitrary functions — `LiveQueryDefinition.authorize` and `.visible` are supplied by the caller —
 * so the question is asked of the error's code rather than of a class this package could import.
 */
export function isPolicyDenial(error: unknown): boolean {
  return POLICY_DENIAL_CODES.has(codeOf(error) ?? '');
}

/** The `X_*` code an unknown throw carries, or `null` — the one place that reads it off `unknown`. */
function codeOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  const code = (error as { code: unknown }).code;
  return typeof code === 'string' ? code : null;
}

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
  X_LIVE_ROW_UNIDENTIFIED: 'a live query returned a row with no id',
  X_LIVE_QUERY_UNKNOWN: 'no live query is registered under the name a subscribe frame asked for',
  X_QUERY_NOT_SUBSCRIBABLE: 'a hook was bound to a query that is not declared live',
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

/**
 * A subscribable read projected a row with no `id`. Patches, cursors and the local store all
 * address a row by `id`, so such a row cannot be delivered — and delivering it anyway produces a
 * subscription that looks correct until the first update nobody can apply.
 */
export class LiveRowUnidentifiedError extends RealtimeError {
  constructor(args: { query: string; keys: readonly string[] }) {
    super({
      code: 'X_LIVE_ROW_UNIDENTIFIED',
      cause: `live query "${args.query}" returned a row with no id (columns: ${args.keys.join(', ') || 'none'})`,
      fix: `select the primary key in ${args.query}'s sql(), or drop live: true from it`,
    });
  }
}

/**
 * A `subscribe` frame named a live query this node does not have. Distinct from a version skew
 * because the two have opposite instructions: this one was reported as `X_PROTOCOL_VERSION`, whose
 * fix is "x build && redeploy the client" — and redeploying a client that spells the name the same
 * way changes nothing, while the registry that would have shown the mismatch never gets opened.
 * A misspelling and an unregistered query produce the same frame, so the fix names both.
 *
 * The name it prints is the one the client sent; the registry is never enumerated back over the
 * wire, because an unauthenticated socket asking for "a" through "zz" is not entitled to a list of
 * every read this app declares.
 *
 * `fix` is the command and nothing else. What to do with what it prints belongs in `cause`: a fix
 * line is pasted into a shell, so prose appended to it is a command that does not run.
 */
export class LiveQueryUnknownError extends RealtimeError {
  constructor(args: { name: string }) {
    super({
      code: 'X_LIVE_QUERY_UNKNOWN',
      cause: `no live query is registered as "${args.name}" on this node — subscribe under a name the registry prints, or pass the query to defineApi({ queries }) if it is missing`,
      fix: 'x queries list --json',
    });
  }
}

/**
 * `liveHookFor` was handed a read that never patches. Refused where the binding is written rather
 * than at the first render, because a hook over a non-live query has nothing to subscribe to — it
 * would return an empty set forever and look like a policy denial or an empty table.
 */
export class QueryNotSubscribableError extends RealtimeError {
  constructor(args: { name: string }) {
    super({
      code: 'X_QUERY_NOT_SUBSCRIBABLE',
      // Empty at module load, when the binding runs and `registerQueries()` has not stamped a
      // name yet — say so rather than printing `query ""`.
      cause: `query ${args.name === '' ? '<unregistered>' : `"${args.name}"`} is not declared live: true, so it has no subscription for a hook to read`,
      fix: 'add live: true to the query declaration, or read it once through query.client({ baseUrl }) — wiki/Queries-And-Live-Queries.md',
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
