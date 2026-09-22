// The wire, READ-ONLY for the client: channel and live-query subscriptions go up, snapshots,
// patches, presence and refusals come down. A client write is HTTP (`useMutation`), never a frame —
// so there is one write path, with the action's authz, idempotency store and contract behind it.

import { renderThrowable, stringField } from '@ultimat3/core/page';
import type {
  ChannelEventsFrame,
  ChannelRecordsFrame,
  ChannelSubscribeTarget,
  ReplayGapFrame,
} from './channel-wire';
import type { LiveCursor } from './cursor';
import {
  isJsonObject,
  isRow,
  type JsonObject,
  type JsonValue,
  type Row,
  type RowPatch,
} from './json';
import { ProtocolVersionError } from './page-errors';
import { channelTarget, events, records, replayGap } from './wire-channel';
import { bounded, fail, list, nullableStr, num, object, pick, str } from './wire-read';
import { FRAME_LIMITS, PROTOCOL_VERSION } from './wire-version';

export type {
  ChannelEventsFrame,
  ChannelRecordsFrame,
  ChannelSubscribeTarget,
  ReplayGapFrame,
} from './channel-wire';
/** The version and the ceilings live below this file so the readers can share them without a cycle. */
export { FRAME_LIMITS, PROTOCOL_VERSION } from './wire-version';

export interface WireError {
  readonly code: string;
  readonly cause: string;
  readonly fix: string;
  readonly docs?: string;
}

export interface PresenceMember {
  readonly id: string;
  readonly actorId: string | null;
  readonly meta: JsonObject;
  /** Client-supplied logical time; last write wins per member on ties-free comparison. */
  readonly updatedAt: number;
}

export type SubscribeTarget =
  /** A declared `channel()`: its NAME and params, never a topic string the client spelled. */
  | ChannelSubscribeTarget
  | {
      /**
       * Client -> server, `qid` carries the *query name*; the server derives the real qid from
       * (name, input) so a client can never pick its own fanout key. Server -> client it is the
       * derived qid, which is also what the cursor is keyed by.
       */
      readonly kind: 'query';
      readonly qid: string;
      readonly input: JsonValue;
      readonly cursor: LiveCursor | null;
    };

/**
 * The opening frame, and the heartbeat's. It carries **no cursors**: resume is decided per
 * subscription by `subscribe`, whose target already carries the cursor and whose `(name, input)`
 * is what the node needs to authorize the read and reach the retained window at all. A cursor's
 * `qid` is `queryHash(name, input)` — a digest, not an input — so a resume list here could never be
 * more than a second, unauthorized restatement of that decision, and it cost every reconnect a
 * duplicate copy of up to `CURSOR_ID_LIMIT` ids per subscription during the exact restart storm
 * `thundering-herd.ts` exists to bound. Removing it needs no `PROTOCOL_VERSION` bump: `decode`
 * builds a whitelist, so a node reads an old client's `resume` as absent and an old node reads a
 * new client's omission the way it already read an empty list.
 */
export interface HelloFrame {
  readonly type: 'hello';
  readonly v: number;
  readonly buildId: string;
  /** Server-assigned on the reply, `null` on the client's opening frame. */
  readonly sessionId: string | null;
  readonly actorId: string | null;
}

export interface SubscribeFrame {
  readonly type: 'subscribe';
  readonly v: number;
  readonly op: 'add' | 'drop';
  readonly sid: string;
  readonly target: SubscribeTarget;
}

export interface SnapshotFrame {
  readonly type: 'snapshot';
  readonly v: number;
  readonly sid: string;
  readonly rows: readonly Row[];
  readonly cursor: LiveCursor;
  /**
   * The entity every row of this result set belongs to — the client's identity scope, so two
   * queries returning post #7 hold one row rather than two copies. Optional and **additive**: it
   * is the one thing a browser cannot derive (the shape is compiled server-side from `sql`), and
   * a client that does not receive it keeps its rows in a scope private to that subscription. Both
   * skews are safe in both directions, which is why it carries no `PROTOCOL_VERSION` bump.
   */
  readonly entity?: string;
  /**
   * Each row's RECORD key, parallel to `rows`, sent only when some key is not its row's `id` (a
   * composite primary key). The server renders it with the entity's projection; the browser never
   * derives a key.
   */
  readonly keys?: readonly string[];
}

export interface PatchFrame {
  readonly type: 'patch';
  readonly v: number;
  readonly sid: string;
  readonly patches: readonly RowPatch[];
  readonly lsn: string;
}

export interface AckFrame {
  readonly type: 'ack';
  readonly v: number;
  /**
   * What a refusal refers to: the sid of a subscription the node refused, or the socket id for a
   * frame it could not read at all. The socket carries no writes, so an ack is never a receipt.
   */
  readonly ref: string;
  readonly lsn: string | null;
  readonly error: WireError | null;
}

export interface ReconnectFrame {
  readonly type: 'reconnect';
  readonly v: number;
  /** Server-assigned delay. Clients must honour it so a drain redistributes instead of stampeding. */
  readonly afterMs: number;
  readonly reason: 'drain' | 'overload' | 'rebalance';
}

export interface UpdateAvailableFrame {
  readonly type: 'update-available';
  readonly v: number;
  readonly buildId: string;
}

export type Frame =
  | HelloFrame
  | SubscribeFrame
  | SnapshotFrame
  | PatchFrame
  | AckFrame
  | ReconnectFrame
  | UpdateAvailableFrame
  | ChannelRecordsFrame
  | ChannelEventsFrame
  | ReplayGapFrame;

export type FrameKind = Frame['type'];

export const FRAME_KINDS: readonly FrameKind[] = [
  'hello',
  'subscribe',
  'snapshot',
  'patch',
  'ack',
  'reconnect',
  'update-available',
  'records',
  'events',
  'replay-gap',
];

export function encode(frame: Frame): string {
  return JSON.stringify(frame);
}

/** Narrow `unknown` to a `Frame` or throw `X_PROTOCOL_VERSION`. No frame is trusted unvalidated. */
export function decode(raw: string | Uint8Array): Frame {
  const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw fail('frame is not JSON');
  }
  if (!isJsonObject(parsed)) throw fail('frame is not an object');
  const version = parsed['v'];
  if (version !== PROTOCOL_VERSION) {
    throw new ProtocolVersionError({ got: version, expected: PROTOCOL_VERSION });
  }
  const kind = parsed['type'];
  switch (kind) {
    case 'hello':
      return {
        type: 'hello',
        v: PROTOCOL_VERSION,
        buildId: str(parsed, 'buildId'),
        sessionId: nullableStr(parsed, 'sessionId'),
        actorId: nullableStr(parsed, 'actorId'),
      };
    case 'subscribe':
      return {
        type: 'subscribe',
        v: PROTOCOL_VERSION,
        op: pick(parsed, 'op', ['add', 'drop'] as const),
        sid: str(parsed, 'sid'),
        target: target(parsed['target']),
      };
    case 'snapshot': {
      const base = {
        type: 'snapshot',
        v: PROTOCOL_VERSION,
        sid: str(parsed, 'sid'),
        rows: list(parsed, 'rows', FRAME_LIMITS.rows).map(row),
        cursor: cursor(parsed['cursor']),
      } as const;
      const entity = nullableStr(parsed, 'entity');
      const scoped = entity === null ? base : { ...base, entity };
      if (parsed['keys'] === undefined) return scoped;
      const keys = list(parsed, 'keys', FRAME_LIMITS.rows).map((key) => {
        if (typeof key !== 'string') throw fail('snapshot.keys must hold strings');
        return key;
      });
      if (keys.length !== base.rows.length) throw fail('snapshot.keys must pair with rows');
      return { ...scoped, keys };
    }
    case 'patch':
      return {
        type: 'patch',
        v: PROTOCOL_VERSION,
        sid: str(parsed, 'sid'),
        patches: list(parsed, 'patches', FRAME_LIMITS.patches).map(patch),
        lsn: str(parsed, 'lsn'),
      };
    case 'ack':
      return {
        type: 'ack',
        v: PROTOCOL_VERSION,
        ref: str(parsed, 'ref'),
        lsn: nullableStr(parsed, 'lsn'),
        error: wireError(parsed['error']),
      };
    case 'reconnect':
      return {
        type: 'reconnect',
        v: PROTOCOL_VERSION,
        afterMs: num(parsed, 'afterMs'),
        reason: pick(parsed, 'reason', ['drain', 'overload', 'rebalance'] as const),
      };
    case 'update-available':
      return { type: 'update-available', v: PROTOCOL_VERSION, buildId: str(parsed, 'buildId') };
    case 'records':
      return records(parsed);
    case 'events':
      return events(parsed);
    case 'replay-gap':
      return replayGap(parsed);
    default:
      throw fail(`unknown frame type ${JSON.stringify(kind)}`);
  }
}

/** Project any thrown value onto the wire without losing the error contract's three fields. */
export function toWireError(error: unknown): WireError {
  // The throwable is an app mutator's, a live query's or a policy's, so its `toString` is the
  // app's too: `String()` here raised inside the handler's catch and the socket got no frame at
  // all, which a reconnect cannot repair because the same call throws the same way.
  // `renderThrowable` keeps an Error's own words without trusting `instanceof` or `.message`, and
  // `stringField` makes the four probes above it as total as the fallback they choose between —
  // `shape?.code` was a raw property read on that same app value.
  const code = stringField(error, 'code') ?? 'X_PROTOCOL_VERSION';
  const cause = stringField(error, 'cause') ?? renderThrowable(error);
  const fix = stringField(error, 'fix') ?? 'x doctor realtime';
  const docs = stringField(error, 'docs');
  return docs === undefined ? { code, cause, fix } : { code, cause, fix, docs };
}

function row(value: unknown): Row {
  if (!isRow(value)) throw fail('row must be an object with a string "id"');
  return value;
}

function cursor(value: unknown): LiveCursor {
  if (!isJsonObject(value)) throw fail('cursor must be an object');
  return {
    qid: str(value, 'qid'),
    lsn: str(value, 'lsn'),
    ids: list(value, 'ids', FRAME_LIMITS.cursorIds, 'cursor.ids').map((id) => {
      if (typeof id !== 'string') throw fail('cursor.ids must be strings');
      return id;
    }),
    at: num(value, 'at'),
  };
}

function patch(value: unknown): RowPatch {
  if (!isJsonObject(value)) throw fail('patch must be an object');
  const base = {
    op: pick(value, 'op', ['insert', 'update', 'delete'] as const),
    id: str(value, 'id'),
    row: value['row'] === null || value['row'] === undefined ? null : object(value['row']),
    lsn: str(value, 'lsn'),
  };
  const indexed = value['index'] === undefined ? base : { ...base, index: num(value, 'index') };
  const key = nullableStr(value, 'key');
  return key === null ? indexed : { ...indexed, key };
}

function target(value: unknown): SubscribeTarget {
  if (!isJsonObject(value)) throw fail('subscribe.target must be an object');
  const kind = pick(value, 'kind', ['query', 'channel'] as const);
  if (kind === 'channel') return channelTarget(value);
  return {
    kind,
    qid: str(value, 'qid'),
    input: bounded(value['input'] ?? null, 'input'),
    cursor:
      value['cursor'] === null || value['cursor'] === undefined ? null : cursor(value['cursor']),
  };
}

function wireError(value: unknown): WireError | null {
  if (value === null || value === undefined) return null;
  if (!isJsonObject(value)) throw fail('ack.error must be an object or null');
  const base = { code: str(value, 'code'), cause: str(value, 'cause'), fix: str(value, 'fix') };
  return value['docs'] === undefined ? base : { ...base, docs: str(value, 'docs') };
}
