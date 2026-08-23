// Realtime's X_* codes. Every throw in this package goes through one of these classes so
// the same string renders in the terminal, the browser overlay, and `--json`.

import { registerErrorCodes } from '@ultimat3/core';
import { RealtimeError } from './realtime-error';

/** Codes this package declares and owns. */
export const REALTIME_OWNED_ERROR_CODES = [
  'X_TOPIC_FORBIDDEN',
  'X_SUBSCRIPTION_LIMIT',
  'X_SUBSCRIPTION_ID_TAKEN',
  'X_FRAME_RATE_LIMIT',
  'X_PROTOCOL_VERSION',
  'X_CURSOR_STALE',
  'X_REBASE_CONFLICT',
  'X_TRANSPORT_UNAVAILABLE',
  'X_TRANSPORT_PROTOCOL',
  'X_REPLICATION_PROTOCOL',
  'X_REPLICATION_FAILED',
  'X_REPLICATOR_SLOT_HELD',
  'X_LIVE_CLIENT_MISSING',
  'X_LIVE_SERVER_RENDER',
  'X_LIVE_ROW_UNIDENTIFIED',
  'X_LIVE_QUERY_UNKNOWN',
  'X_LIVE_REPLICA_IDENTITY',
  'X_QUERY_NOT_SUBSCRIBABLE',
  'X_SOCKET_UNAUTHENTICATED',
  'X_SOCKET_AUTH_UNAVAILABLE',
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
  'X_SUBSCRIPTION_ID_TAKEN',
  // The client is the one sending too fast, and it is the one that can stop.
  'X_FRAME_RATE_LIMIT',
  'X_PROTOCOL_VERSION',
  'X_LIVE_QUERY_UNKNOWN',
  'X_CURSOR_STALE',
  'X_REBASE_CONFLICT',
  // The credential is the client's to send; the node deciding it has none is not this node failing.
  // Its twin, `X_SOCKET_AUTH_UNAVAILABLE`, is deliberately absent — that one IS this node failing.
  'X_SOCKET_UNAUTHENTICATED',
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
  X_SUBSCRIPTION_LIMIT: 'socket, tenant or node hit its subscription cap',
  X_SUBSCRIPTION_ID_TAKEN: 'a subscribe frame reused a sid this socket already holds',
  X_FRAME_RATE_LIMIT: 'one socket sent frames faster than this node will route them',
  X_PROTOCOL_VERSION: 'client and sync node disagree on the wire protocol',
  X_CURSOR_STALE: 'the resume LSN is outside the change buffer',
  X_REBASE_CONFLICT: 'a local mutation could not be rebased',
  X_TRANSPORT_UNAVAILABLE: 'the fanout bus is unreachable',
  X_TRANSPORT_PROTOCOL: 'the bus does not speak the protocol this build speaks',
  X_REPLICATION_PROTOCOL: 'the WAL stream cannot be decoded',
  X_REPLICATION_FAILED: 'the replication connection was refused',
  X_REPLICATOR_SLOT_HELD: 'another replicator already owns this database',
  X_LIVE_CLIENT_MISSING: 'a realtime hook ran in a browser with no LiveClient registered',
  X_LIVE_SERVER_RENDER: 'a browser-only live operation ran during a server render',
  X_LIVE_ROW_UNIDENTIFIED: 'a live query returned a row with no id',
  X_LIVE_QUERY_UNKNOWN: 'no live query is registered under the name a subscribe frame asked for',
  X_LIVE_REPLICA_IDENTITY: 'a replicated table sends a key-only row on delete',
  X_QUERY_NOT_SUBSCRIBABLE: 'a hook was bound to a query that is not declared live',
  X_SOCKET_UNAUTHENTICATED: 'the sync upgrade carried no credential this app accepts',
  X_SOCKET_AUTH_UNAVAILABLE: 'the sync node could not decide who a connecting socket is',
};

// One unconditional call, so a second package claiming one of realtime's codes throws
// X_ERROR_CODE_DUPLICATE instead of losing silently to whichever module imported first.
registerErrorCodes(
  Object.fromEntries(
    Object.entries(REALTIME_ERROR_TITLES).map(([code, title]) => [code, { title }]),
  ),
);

// Re-exported, never re-declared: `RealtimeError` lives in `realtime-error.ts` and the four
// replication errors in `replication-errors.ts`, so this file stays the CODE TABLE plus the
// client-reachable refusals. Every name is still importable from `./errors`, which is what the
// seventeen `pg-*` modules and the barrel already do.
export { RealtimeError } from './realtime-error';
export {
  ReplicaIdentityError,
  ReplicationFailedError,
  ReplicationProtocolError,
  ReplicatorSlotHeldError,
} from './replication-errors';

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

/**
 * Load shedding, not a crash: a socket, a tenant or this node asked for more than its cap.
 *
 * `knob` is the option that raises it, and it is passed rather than derived because the `node`
 * scope has more than one — a live-query entry ceiling and a channel-topic ceiling are two
 * different numbers on two different objects. The fix names the constructor option, never an
 * `app.config.ts` field: there is none (`docs/architecture/07-realtime-internals.md:244`), and a
 * fix line naming a field that does not exist is an instruction that cannot be followed.
 */
export class SubscriptionLimitError extends RealtimeError {
  constructor(args: {
    scope: 'socket' | 'tenant' | 'node';
    id: string;
    limit: number;
    knob?: string;
  }) {
    const knob = args.knob ?? (args.scope === 'socket' ? 'maxPerSocket' : 'maxPerTenant');
    super({
      code: 'X_SUBSCRIPTION_LIMIT',
      cause: `${args.scope} ${args.id} reached the subscription cap of ${args.limit}`,
      fix: `raise ${knob} where this sync node is constructed, or unsubscribe unused live queries`,
    });
  }
}

/**
 * One socket sent frames faster than the node will route them. The accept budget spends a token
 * per UPGRADE, so before this existed an authenticated socket — the cheapest possible foothold —
 * could drive an unbounded number of subscribe frames into a DB read, a presence write and a
 * fleet-wide publish each, with nothing between the frame and the work.
 *
 * A client fault, so it never pages anyone: the ack frame carries this and the client backs off.
 */
export class FrameRateLimitError extends RealtimeError {
  constructor(args: { socketId: string; perSecond: number }) {
    super({
      code: 'X_FRAME_RATE_LIMIT',
      cause: `socket ${args.socketId} exceeded ${args.perSecond} frames per second`,
      fix: 'batch subscribes into one frame per subscription and retry after the delay, or raise maxFramesPerSecond where createSyncNode() is called',
    });
  }
}

/**
 * The client chose a subscription id it is already using on this socket. Refused rather than
 * replaced: attaching over it would strand the earlier subscription inside its query entry, where
 * nothing can unsubscribe it and the entry's matcher and shared window are never freed.
 */
export class SubscriptionIdTakenError extends RealtimeError {
  constructor(args: { sid: string; socketId: string }) {
    super({
      code: 'X_SUBSCRIPTION_ID_TAKEN',
      cause: `socket ${args.socketId} already holds a live subscription with sid "${args.sid}"`,
      fix: 'send a fresh sid with each subscribe frame — crypto.randomUUID() is what the bundled client uses',
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
 * A hook was called IN A BROWSER before the app entry registered its client. Never a transient
 * fault: the registration is a single call in the entry, so the fix is the call itself rather than
 * a retry.
 *
 * A server render is deliberately not this error, and never was a missing registration: there is
 * no socket to register a client for. It gets `serverRenderLiveClient()` instead — the same rule
 * `@ultimat3/ui`'s `solid()` follows for a missing Solid runtime, one package over.
 */
export class LiveClientMissingError extends RealtimeError {
  constructor(args: { hook: string }) {
    super({
      code: 'X_LIVE_CLIENT_MISSING',
      cause: `${args.hook}() ran in a browser before any LiveClient was registered`,
      fix: 'setLiveClient(new LiveClient({ signal: createSignal, connect, buildId })) in the app entry, above the first render',
    });
  }
}

/**
 * Something that can only mean "talk to the socket" ran on the server client — a mutation, a
 * publish, a topic subscription, a dial. There is no socket during a server render and there never
 * will be one: the document is built and sent, and the browser opens the connection.
 *
 * A refusal rather than a silent no-op, because both alternatives are worse. Queueing it would
 * hold one process-wide queue on behalf of whichever request happened to render, and dropping it
 * would make a write that never happened look like one that did.
 */
export class ServerRenderLiveError extends RealtimeError {
  constructor(args: { operation: string }) {
    super({
      code: 'X_LIVE_SERVER_RENDER',
      cause: `${args.operation} ran during a server render, where this app has no live socket`,
      fix: 'call it from an island mount() instead of from the page — or guard it with hasLiveClient(), which answers false on the server',
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

/**
 * The app's `authenticate` decided this upgrade belongs to nobody. A **decision**, so it is the
 * client's own condition and never pages anyone: the refusal is the whole point of the hook.
 *
 * Distinct from `X_TOPIC_FORBIDDEN`, which is a subscriber that got a socket and then asked for
 * something it may not have. This one never gets a socket at all — a websocket refused after the
 * upgrade is a connection the client must tear down to learn about.
 */
export class SocketUnauthenticatedError extends RealtimeError {
  constructor(args: { reason: string }) {
    super({
      code: 'X_SOCKET_UNAUTHENTICATED',
      cause: `the websocket upgrade was refused: ${args.reason}`,
      fix: 'send the credential createSyncNode({ authenticate }) reads on the upgrade request, or return an anonymous Actor from it to admit this socket',
    });
  }
}

/**
 * `authenticate` raised instead of deciding. The same rule the row gate follows: a failure is not a
 * denial, so the client is told to come back rather than told it may not connect — a token service
 * that timed out must not read to a user as "you are signed out", and it must page someone.
 */
export class SocketAuthUnavailableError extends RealtimeError {
  constructor(args: { detail: string }) {
    super({
      code: 'X_SOCKET_AUTH_UNAVAILABLE',
      cause: `authenticate() raised instead of deciding who a connecting socket is: ${args.detail}`,
      fix: 'x doctor --json',
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
