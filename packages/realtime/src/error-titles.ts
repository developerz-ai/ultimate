// @ultimat3/realtime's owned codes and their TITLES, registered at import — the one module
// `sideEffects` names, so `errors.ts` (the sync node's refusal classes) is unlisted and no hook's
// chunk carries it (`page-errors-bundle.test.ts`): measured on Bun 1.4.2, −1,081 B on `feed`, −1,051 B on `likes-badge`, −1,047 B on
// `run-console`, every title still registered. Imported bare by `index.ts` (a page
// rebuilds a node's refusal by code in `refusalError`, and `page-errors.ts` constructs codes from
// here without importing it) and by `errors.ts`, so constructing a server refusal registers too.

import { registerErrorCodes } from '@ultimat3/core';

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
  'X_OFFLINE_QUEUE_ABANDONED',
  'X_SOCKET_LIMIT',
] as const;

export type RealtimeOwnedErrorCode = (typeof REALTIME_OWNED_ERROR_CODES)[number];

export const REALTIME_ERROR_TITLES: Readonly<Record<RealtimeOwnedErrorCode, string>> = {
  X_TOPIC_FORBIDDEN: 'the actor may not subscribe to this topic',
  X_SUBSCRIPTION_LIMIT: 'socket, actor, tenant or node hit its subscription cap',
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
  X_OFFLINE_QUEUE_ABANDONED: 'a write was queued after its page changed principal',
  X_SOCKET_LIMIT: 'one principal holds too many sockets on this node',
};

// One unconditional call, so a second package claiming one of realtime's codes throws
// X_ERROR_CODE_DUPLICATE instead of losing silently to whichever module imported first.
registerErrorCodes(
  Object.fromEntries(
    Object.entries(REALTIME_ERROR_TITLES).map(([code, title]) => [code, { title }]),
  ),
);
