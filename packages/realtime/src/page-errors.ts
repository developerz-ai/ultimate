// The refusals a BROWSER can reach — the page store, the hooks, the socket's wire check, the local
// store. Apart from `errors.ts` for bytes: that module registers the whole code table at import,
// and an island that renders one record has no use for sixty titles. The codes stay in `errors.ts`
// (its `registerErrorCodes()` is what `package.json`'s `sideEffects` names, anchored by the
// barrel); in a browser that loaded no table a code titles itself from its name, and `code`,
// `cause` and `fix` — what a reader acts on — are unchanged. This module runs nothing at import.

import { renderFixShellArg } from '@ultimat3/core/page';
import { RealtimeError } from './realtime-error';

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

/**
 * A hook ran IN A BROWSER in an island bundle whose bootstrap never called `installRealtime()`.
 * Per BUNDLE, not per page: every island carries its own copy of solid-js, so the signal factory a
 * hook renders through has to be that island's own — the page-wide store cannot hold one.
 *
 * A server render is deliberately not this error: no DOM means no reactive runtime to install,
 * and the hooks answer the honest server-render state instead.
 */
export class RealtimeUninstalledError extends RealtimeError {
  constructor(args: { hook: string }) {
    super({
      code: 'X_REALTIME_UNINSTALLED',
      cause: `${args.hook}() ran in a browser island whose bundle never called installRealtime()`,
      fix: "x build   # the island bootstrap installs it; a hand-built island calls installRealtime({ signal: createSignal }) from '@ultimat3/realtime' before its first render",
    });
  }
}

/** A live hook needed the page's one socket, and nothing told this page where the sync node is. */
export class SyncUnconfiguredError extends RealtimeError {
  constructor(args: { hook: string }) {
    super({
      code: 'X_SYNC_UNCONFIGURED',
      cause: `${args.hook}() needs the page socket, and installRealtime() was given no sync target`,
      fix: "x build   # the island bootstrap passes it; a hand-built island calls installRealtime({ signal: createSignal, sync: { url, buildId } }) from '@ultimat3/realtime'",
    });
  }
}

/**
 * A row reached the record store it cannot hold: not an object, or under no key. Dropped and
 * reported, never partially merged — a keyless row would overwrite another record.
 */
export class RecordRejectedError extends RealtimeError {
  constructor(args: { type: string; reason: string }) {
    super({
      code: 'X_RECORD_REJECTED',
      cause: `a ${args.type === '' ? 'record' : `"${args.type}" record`} was rejected by the page's record store: ${args.reason}`,
      fix: `x entities describe ${renderFixShellArg(args.type, '<entity>')} --json   # the primary key every row of it must carry; return whole rows from the handler that built this one`,
    });
  }
}

/**
 * IndexedDB would not open (a private window, storage disabled), so the page keeps records and its
 * outbox in memory. A WARNING, never thrown: a page must not break because it cannot remember, so
 * `openLocalStore` hands this to its `warn` once and carries on.
 */
export class LocalStoreUnavailableError extends RealtimeError {
  constructor(args: { reason: string }) {
    super({
      code: 'X_LOCAL_STORE_UNAVAILABLE',
      cause: `the page's durable store could not open (${args.reason}), so records and queued writes live in memory and are lost on reload`,
      fix: 'nothing to do in the app — allow site storage in the browser (a private window blocks it) and reload',
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
      fix: 'move the call into an island: x g island <route-dir> --at <route-dir>, import from its mount(), declare island({ src })',
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
