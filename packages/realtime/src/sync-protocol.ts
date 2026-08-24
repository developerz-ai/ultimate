// The wire. One protocol for all three tiers: a channel subscribe, a live-query subscribe, and an
// offline mutation drain are frames in the same union. Moving a route from tier 2 to tier 3 is a
// config flag (`persist: true`), never a new protocol — that promise is enforced here.

import { renderThrowable, stringField } from '@ultimat3/core';
import { CURSOR_ID_LIMIT, type LiveCursor } from './cursor';
import { ProtocolVersionError } from './errors';
import {
  isJsonObject,
  isRow,
  type JsonObject,
  type JsonValue,
  type Row,
  type RowPatch,
} from './json';

/**
 * **2 since 2026-08-24**, when `cursor.digest` and `cursor.count` were deleted. The version guards
 * incompatibility, never novelty — an additive optional field (`snapshot.entity`) and a removed
 * field read through `list()` (`hello.resume`) both stayed at 1, because `decode` is a whitelist
 * and `list()` answers `[]` for an absent field. `cursor()` is the other kind of reader: it reads
 * through `str`/`num`, which THROW on an absent field, so a cursor without those two is a frame a
 * node or a client one deploy behind cannot read — in BOTH directions, since a cursor rides the
 * client's `subscribe` and the node's `snapshot`. That is exactly what this number refuses, with
 * one instruction instead of a per-frame "field \"digest\" must be a string".
 */
export const PROTOCOL_VERSION = 2;

/**
 * What one frame may contain. Hard ceilings a caller cannot widen — the shape
 * `packages/mcp/src/query-limits.ts` uses — because every one of them is read off a socket the
 * node has already paid for: an unbounded `cursor.ids` was consumed raw into a `Set`, and an
 * `input` of arbitrary depth reached `canonicalJson`, which recurses.
 *
 * Every number clears what this node itself produces, or the decoder refuses its own frames on
 * the next reconnect: `cursorIds` is `CURSOR_ID_LIMIT`, `patches` clears
 * `defaultReconnectBudget.maxPatches`.
 */
export const FRAME_LIMITS = Object.freeze({
  cursorIds: CURSOR_ID_LIMIT,
  patches: 4_096,
  rows: 10_000,
  members: 4_096,
  /** Nesting one `input` may reach. 32 is far past any query's real argument shape. */
  inputDepth: 32,
  /** Values one `input` may hold in total, so a flat-but-enormous object is refused too. */
  inputNodes: 10_000,
});

export type ConflictStrategyName = 'server-wins' | 'last-write-wins' | 'custom';

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
  | { readonly kind: 'topic'; readonly topic: string }
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
}

export interface PatchFrame {
  readonly type: 'patch';
  readonly v: number;
  readonly sid: string;
  readonly patches: readonly RowPatch[];
  readonly lsn: string;
}

export interface MutateFrame {
  readonly type: 'mutate';
  readonly v: number;
  /** Idempotency key. The server collapses repeats; the client never renumbers. */
  readonly key: string;
  readonly seq: number;
  readonly name: string;
  readonly input: JsonValue;
}

export interface AckFrame {
  readonly type: 'ack';
  readonly v: number;
  /** Mutation key or subscription id being acknowledged. */
  readonly ref: string;
  readonly lsn: string | null;
  readonly error: WireError | null;
}

export interface RebaseFrame {
  readonly type: 'rebase';
  readonly v: number;
  readonly key: string;
  readonly entity: string;
  readonly strategy: ConflictStrategyName;
  /** Server truth for the row the mutation touched; `null` when the server deleted it. */
  readonly row: Row | null;
}

export interface PresenceFrame {
  readonly type: 'presence';
  readonly v: number;
  readonly topic: string;
  readonly op: 'join' | 'leave' | 'update' | 'sync';
  readonly members: readonly PresenceMember[];
  /**
   * Members in the whole set behind a `sync` frame, which is capped: a 5,000-avatar row is not a UI
   * anyone renders, and the count is what lets a client say "and 4,744 others" without holding
   * them. Optional and **additive**, exactly like `snapshot.entity`: an old node omits it and a new
   * one reads its absence as "this frame is the whole set", so neither skew is unreadable and
   * `PROTOCOL_VERSION` does not move. Never set on a `join`/`leave`/`update` — those are deltas.
   */
  readonly total?: number;
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
  | MutateFrame
  | AckFrame
  | RebaseFrame
  | PresenceFrame
  | ReconnectFrame
  | UpdateAvailableFrame;

export type FrameKind = Frame['type'];

export const FRAME_KINDS: readonly FrameKind[] = [
  'hello',
  'subscribe',
  'snapshot',
  'patch',
  'mutate',
  'ack',
  'rebase',
  'presence',
  'reconnect',
  'update-available',
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
      return entity === null ? base : { ...base, entity };
    }
    case 'patch':
      return {
        type: 'patch',
        v: PROTOCOL_VERSION,
        sid: str(parsed, 'sid'),
        patches: list(parsed, 'patches', FRAME_LIMITS.patches).map(patch),
        lsn: str(parsed, 'lsn'),
      };
    case 'mutate':
      return {
        type: 'mutate',
        v: PROTOCOL_VERSION,
        key: str(parsed, 'key'),
        seq: num(parsed, 'seq'),
        name: str(parsed, 'name'),
        input: bounded(parsed['input'] ?? null, 'input'),
      };
    case 'ack':
      return {
        type: 'ack',
        v: PROTOCOL_VERSION,
        ref: str(parsed, 'ref'),
        lsn: nullableStr(parsed, 'lsn'),
        error: wireError(parsed['error']),
      };
    case 'rebase':
      return {
        type: 'rebase',
        v: PROTOCOL_VERSION,
        key: str(parsed, 'key'),
        entity: str(parsed, 'entity'),
        strategy: pick(parsed, 'strategy', ['server-wins', 'last-write-wins', 'custom'] as const),
        row: parsed['row'] === null ? null : row(parsed['row']),
      };
    case 'presence': {
      const base = {
        type: 'presence',
        v: PROTOCOL_VERSION,
        topic: str(parsed, 'topic'),
        op: pick(parsed, 'op', ['join', 'leave', 'update', 'sync'] as const),
        members: list(parsed, 'members', FRAME_LIMITS.members).map(member),
      } as const;
      return parsed['total'] === undefined ? base : { ...base, total: num(parsed, 'total') };
    }
    case 'reconnect':
      return {
        type: 'reconnect',
        v: PROTOCOL_VERSION,
        afterMs: num(parsed, 'afterMs'),
        reason: pick(parsed, 'reason', ['drain', 'overload', 'rebalance'] as const),
      };
    case 'update-available':
      return { type: 'update-available', v: PROTOCOL_VERSION, buildId: str(parsed, 'buildId') };
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

function fail(detail: string): ProtocolVersionError {
  return new ProtocolVersionError({ got: detail, expected: PROTOCOL_VERSION, detail });
}

function str(obj: JsonObject, key: string): string {
  const value = obj[key];
  if (typeof value !== 'string') throw fail(`field "${key}" must be a string`);
  return value;
}

function nullableStr(obj: JsonObject, key: string): string | null {
  const value = obj[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw fail(`field "${key}" must be a string or null`);
  return value;
}

function num(obj: JsonObject, key: string): number {
  const value = obj[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw fail(`field "${key}" must be a finite number`);
  }
  return value;
}

function pick<T extends string>(obj: JsonObject, key: string, allowed: readonly T[]): T {
  const value = str(obj, key);
  const found = allowed.find((candidate) => candidate === value);
  if (found === undefined) throw fail(`field "${key}" must be one of ${allowed.join('|')}`);
  return found;
}

/**
 * An array field, with the ceiling the caller had to choose. `max` is required rather than
 * defaulted: a new list field on a new frame is a new thing an authenticated socket can make
 * arbitrarily large, and a default would let one ship without anyone deciding its size.
 */
function list(obj: JsonObject, key: string, max: number, label = key): JsonValue[] {
  const value = obj[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw fail(`field "${label}" must be an array`);
  if (value.length > max) {
    throw fail(`field "${label}" carries ${value.length} entries, over the limit of ${max}`);
  }
  return value;
}

/**
 * A client-supplied value, walked ITERATIVELY to its limits. Iteratively because the thing being
 * refused is a stack overflow: `queryHash` -> `canonicalJson` recurses over exactly this value, so a
 * depth check that recursed would be the same crash one frame earlier.
 */
function bounded(value: JsonValue, label: string): JsonValue {
  const stack: { node: JsonValue; depth: number }[] = [{ node: value, depth: 1 }];
  let seen = 0;
  while (stack.length > 0) {
    // `pop` cannot answer undefined here — the loop guard is the length — and the check is what
    // makes that readable to the compiler without a cast.
    const next = stack.pop();
    if (next === undefined) break;
    seen += 1;
    if (seen > FRAME_LIMITS.inputNodes) {
      throw fail(`field "${label}" holds more than ${FRAME_LIMITS.inputNodes} values`);
    }
    if (next.depth > FRAME_LIMITS.inputDepth) {
      throw fail(`field "${label}" is nested deeper than ${FRAME_LIMITS.inputDepth}`);
    }
    if (next.node === null || typeof next.node !== 'object') continue;
    const children = Array.isArray(next.node) ? next.node : Object.values(next.node);
    for (const child of children) stack.push({ node: child, depth: next.depth + 1 });
  }
  return value;
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
  return value['index'] === undefined ? base : { ...base, index: num(value, 'index') };
}

function member(value: unknown): PresenceMember {
  if (!isJsonObject(value)) throw fail('presence member must be an object');
  return {
    id: str(value, 'id'),
    actorId: nullableStr(value, 'actorId'),
    meta: object(value['meta'] ?? {}),
    updatedAt: num(value, 'updatedAt'),
  };
}

function target(value: unknown): SubscribeTarget {
  if (!isJsonObject(value)) throw fail('subscribe.target must be an object');
  const kind = pick(value, 'kind', ['topic', 'query'] as const);
  if (kind === 'topic') return { kind, topic: str(value, 'topic') };
  return {
    kind,
    qid: str(value, 'qid'),
    input: bounded(value['input'] ?? null, 'input'),
    cursor:
      value['cursor'] === null || value['cursor'] === undefined ? null : cursor(value['cursor']),
  };
}

function object(value: unknown): JsonObject {
  if (!isJsonObject(value)) throw fail('expected a JSON object');
  return value;
}

function wireError(value: unknown): WireError | null {
  if (value === null || value === undefined) return null;
  if (!isJsonObject(value)) throw fail('ack.error must be an object or null');
  const base = { code: str(value, 'code'), cause: str(value, 'cause'), fix: str(value, 'fix') };
  return value['docs'] === undefined ? base : { ...base, docs: str(value, 'docs') };
}
