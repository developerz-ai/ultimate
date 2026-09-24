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
  // Retired in 21.0.0 and never thrown since — kept registered, because a shipped code is
  // forever: a log line from an older build still resolves through `x errors explain`.
  'X_LIVE_CLIENT_MISSING',
  'X_QUERY_NOT_SUBSCRIBABLE',
  'X_REALTIME_UNINSTALLED',
  'X_SYNC_UNCONFIGURED',
  'X_RECORD_REJECTED',
  'X_CHANNEL_DECLARATION_INVALID',
  'X_LOCAL_STORE_UNAVAILABLE',
  'X_LIVE_SERVER_RENDER',
  'X_LIVE_ROW_UNIDENTIFIED',
  'X_LIVE_QUERY_UNKNOWN',
  'X_LIVE_REPLICA_IDENTITY',
  'X_SOCKET_UNAUTHENTICATED',
  'X_SOCKET_AUTH_UNAVAILABLE',
  'X_REALTIME_TOPOLOGY',
  'X_REPLICATION_TLS',
  'X_SOCKET_ORIGIN_REFUSED',
] as const;

/**
 * `X_NOT_IMPLEMENTED` is `@ultimat3/core`'s, and `X_FORBIDDEN` — thrown by the surface denials this
 * package renders — is `@ultimat3/policy`'s. Neither is titled here: the owner writes the one title
 * every surface renders, and a copy kept alongside it is a copy that goes stale unnoticed.
 *
 * `X_TIMEOUT` is core's too — titled in `CORE_CODE_TITLES` and classified `retryable` there, which
 * is what a blown deadline owes a caller. Borrowed rather than owned for the same reason
 * `@ultimat3/http` borrows it (`HTTP_BORROWED_ERROR_CODES`): the concept is core's, and a title
 * registered here would throw `X_ERROR_CODE_DUPLICATE` at import.
 */
export const REALTIME_BORROWED_ERROR_CODES = ['X_NOT_IMPLEMENTED', 'X_TIMEOUT'] as const;

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
  X_LIVE_CLIENT_MISSING:
    'retired in 21.0.0 (no LiveClient to register; see X_REALTIME_UNINSTALLED): a realtime hook ran in a browser with no LiveClient registered',
  X_QUERY_NOT_SUBSCRIBABLE:
    'retired in 21.0.0 (liveHookFor was deleted; useQuery reads any query): a hook was bound to a query that is not declared live',
  X_REALTIME_UNINSTALLED: 'a realtime hook ran in an island bundle that never installed realtime',
  X_SYNC_UNCONFIGURED: 'a live hook needed the page socket and no sync target was configured',
  X_RECORD_REJECTED: 'a row reached the record store in a shape it cannot hold',
  X_CHANNEL_DECLARATION_INVALID: 'a channel() declaration cannot route its rows',
  X_LOCAL_STORE_UNAVAILABLE: "the page's durable store could not open",
  X_LIVE_SERVER_RENDER: 'a browser-only live operation ran during a server render',
  X_LIVE_ROW_UNIDENTIFIED: 'a live query returned a row with no id',
  X_LIVE_QUERY_UNKNOWN: 'no live query is registered under the name a subscribe frame asked for',
  X_LIVE_REPLICA_IDENTITY: 'a replicated table has no replica identity',
  X_SOCKET_UNAUTHENTICATED: 'the sync upgrade carried no credential this app accepts',
  X_SOCKET_AUTH_UNAVAILABLE: 'the sync node could not decide who a connecting socket is',
  X_REALTIME_TOPOLOGY: 'a sync node boots on a real database with no reachable change feed',
  X_REPLICATION_TLS: 'the replication connection failed TLS',
  X_SOCKET_ORIGIN_REFUSED: 'the websocket upgrade came from another origin',
};

// One unconditional call, so a second package claiming one of realtime's codes throws
// X_ERROR_CODE_DUPLICATE instead of losing silently to whichever module imported first.
registerErrorCodes(
  Object.fromEntries(
    Object.entries(REALTIME_ERROR_TITLES).map(([code, title]) => [code, { title }]),
  ),
);

export {
  CursorStaleError,
  LocalStoreUnavailableError,
  ProtocolVersionError,
  RealtimeUninstalledError,
  RebaseConflictError,
  RecordRejectedError,
  ServerRenderLiveError,
  SyncUnconfiguredError,
} from './page-errors';
// Re-exported, never re-declared: `RealtimeError` lives in `realtime-error.ts`, the four
// replication errors in `replication-errors.ts` and the browser-reachable refusals in
// `page-errors.ts`, so this file is the CODE TABLE plus the server's refusals. Every name is still
// importable from `./errors`, which is what the `pg-*` modules and the barrel already do; a
// browser module imports `./page-errors` so it does not load the table.
export { RealtimeError } from './realtime-error';
export {
  ReplicaIdentityError,
  ReplicationFailedError,
  ReplicationProtocolError,
  ReplicationTlsError,
  ReplicatorSlotHeldError,
} from './replication-errors';

/** Subscribe (or an actor change) denied by the topic's policy. Never leaks the topic's data. */
export class TopicForbiddenError extends RealtimeError {
  constructor(args: { topic: string; actorId: string | null; reason: string }) {
    super({
      code: 'X_TOPIC_FORBIDDEN',
      cause: `actor ${args.actorId ?? '<anonymous>'} may not subscribe to "${args.topic}": ${args.reason}`,
      // The topic's first segment is its channel's name; the policy on that declaration decides.
      fix: 'x policy list --json   # then widen the policy on the channel() declaration this topic belongs to, or subscribe as an actor it allows',
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
 * A `sync` node that can hear no change: a real database, the in-process bus, and no replicator in
 * this process. A replicator in another process publishes into ITS in-process bus, so every live
 * query and channel here is silent, with no error on either side. Refused at boot, where the
 * topology is known, rather than discovered as a live feature that never updates.
 */
export class RealtimeTopologyError extends RealtimeError {
  constructor() {
    super({
      code: 'X_REALTIME_TOPOLOGY',
      cause:
        'role sync runs on an external database over the in-process transport with no replicator in this process, so no committed change can reach it',
      // Since 22.0.0 NATS_URL alone selects nothing: `realtime.transport` does, and a set NATS_URL
      // under `'memory'` is refused, so the fix has to name both halves.
      fix: "set realtime: { transport: 'nats', urlEnv: 'NATS_URL' } in app.config.ts and NATS_URL for every realtime role (web, sync, replicator), or run ROLE=sync with the replicator in one process: x dev --role sync,replicator",
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
 * A browser page on another origin asked for a socket. No CORS applies to a websocket and the
 * session cookie rides it, so admitting the upgrade would open a socket AS the visitor for a page
 * that is not this app — cross-site websocket hijacking. Decided before `authenticate` and before
 * the accept budget, so a hostile page costs neither.
 */
export class SocketOriginRefusedError extends RealtimeError {
  constructor(args: { reason: string }) {
    super({
      code: 'X_SOCKET_ORIGIN_REFUSED',
      cause: `the websocket upgrade was refused: ${args.reason}`,
      fix: "dial the socket from the app's own origin; if the page is served on another host, set APP_URL on the sync role to that origin, or pass createSyncNode({ allowedOrigins: ['https://www.example.com'] })",
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

/**
 * The shared window read for one live query id blew its deadline.
 *
 * Freeing the slot alone would leave every caller ALREADY joined to that read waiting on a promise
 * nothing will ever settle, so they are TOLD instead — the same answer this file's other
 * non-answering read gives, and the reason `fillWindow` needed no new branch to carry it. The read
 * itself is not cancellable from here and this does not pretend to have stopped it.
 */
export class WindowReadTimeoutError extends RealtimeError {
  constructor(args: { qid: string; afterMs: number }) {
    super({
      code: 'X_TIMEOUT',
      cause: `the shared snapshot read for live query "${args.qid}" did not answer within ${args.afterMs}ms, so the window slot it held was released`,
      fix: 'x doctor --json   # then raise readDeadlineMs on the live query registry, or fix the snapshot read that stopped answering',
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
