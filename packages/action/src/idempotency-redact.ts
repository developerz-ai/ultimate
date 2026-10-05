/**
 * One job: the copy of an idempotent answer that may be kept AT REST — every value under a key
 * core's `isRedactedKey` names, every `Secret` box, and everything the walk cannot vouch for
 * replaced by `[redacted]`. The rule is core's table, the one `audit-input.ts` and the logger ask.
 */
import { isRedactedKey, isSecret, REDACTED } from '@ultimat3/core';

/**
 * How deep the walk inspects. Past it the subtree is REDACTED, never kept: what was not looked at
 * cannot be shown to hold no credential, and the record of it outlives the request by a day. An
 * output schema deep enough to reach this is a recursive one, and its replay is refused rather
 * than served with a credential in it.
 */
export const IDEMPOTENCY_REDACT_MAX_DEPTH = 32;

export interface RestingAnswer {
  /** What the store may write down. The ORIGINAL reference when nothing was redacted. */
  readonly value: unknown;
  /** True when anything was replaced — the record's flag, so a replay never scans for a string. */
  readonly redacted: boolean;
}

interface WalkState {
  redacted: boolean;
}

/**
 * The answer as it may rest. Plain data — objects whose prototype is `Object.prototype` or
 * `null`, arrays, `Date`, primitives — with no redacted key comes back as the SAME reference, so
 * the common case stores and replays exactly what it did before.
 *
 * **Fail closed on everything else.** The Postgres store writes `JSON.stringify(value)`, which
 * runs app code this walk never saw: a `toJSON` (on a class, a plain object, an array, even a
 * function) may return `{ apiKey }`, and a getter read a second time may return something else.
 * So a value with a callable `toJSON`, a `Map`, a `Set`, a class instance or a `Date` subclass is
 * `[redacted]` and the record flagged — its replay is refused, which is the honest answer for an
 * answer this walk could not judge. An own getter is read ONCE and the subtree copied, so the
 * serializer reads the value that was judged, not a fresh one. `toJSON` is never called. A CYCLE
 * is cut the same way — its back-reference becomes `[redacted]` — so both stores keep one
 * serializable copy; a value repeated as siblings is not a cycle and is kept.
 */
export function restingAnswer(value: unknown): RestingAnswer {
  const state: WalkState = { redacted: false };
  const out = walk(value, 0, new Set(), state);
  return { value: out, redacted: state.redacted };
}

function redact(state: WalkState): string {
  state.redacted = true;
  return REDACTED;
}

/** `JSON.stringify` asks for `toJSON` on any object — a function included. */
function hasToJson(value: object): boolean {
  return typeof (value as { toJSON?: unknown }).toJSON === 'function';
}

/** A `Date` whose `toJSON` is the built-in one: its own prototype, no own override. */
function isPlainDate(value: object): boolean {
  return Object.getPrototypeOf(value) === Date.prototype && !Object.hasOwn(value, 'toJSON');
}

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function walk(value: unknown, depth: number, ancestors: Set<object>, state: WalkState): unknown {
  if (typeof value === 'function') return hasToJson(value) ? redact(state) : value;
  if (typeof value !== 'object' || value === null) return value;
  if (isSecret(value)) return redact(state);
  if (isPlainDate(value)) return value;
  // A back-reference fails closed: kept, `JSON.stringify` throws in the Postgres store after the
  // handler committed, while the memory store would accept it — two answers for one record.
  if (ancestors.has(value)) return redact(state);
  const array = Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype;
  if (hasToJson(value) || !(array || isPlainObject(value))) return redact(state);
  if (depth >= IDEMPOTENCY_REDACT_MAX_DEPTH) return redact(state);
  ancestors.add(value);
  try {
    return array
      ? walkArray(value as readonly unknown[], depth, ancestors, state)
      : walkObject(value, depth, ancestors, state);
  } finally {
    ancestors.delete(value);
  }
}

/**
 * One read of an own property: a data property's value, or its getter called exactly once.
 * `copy` says the subtree must be copied for the read to be the one the serializer sees.
 */
function readOnce(target: object, key: string | number): { value: unknown; copy: boolean } {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (descriptor === undefined) return { value: undefined, copy: false };
  if (descriptor.get !== undefined) return { value: descriptor.get.call(target), copy: true };
  return { value: descriptor.value, copy: false };
}

function walkArray(
  value: readonly unknown[],
  depth: number,
  ancestors: Set<object>,
  state: WalkState,
): unknown {
  let copy: unknown[] | undefined;
  // Indexed, not `forEach`: a hole is visited (as `undefined`) and kept in its place.
  for (let index = 0; index < value.length; index += 1) {
    const read = readOnce(value, index);
    const next = walk(read.value, depth + 1, ancestors, state);
    if (read.copy || next !== read.value) copy ??= value.slice(0, index);
    copy?.push(next);
  }
  return copy ?? value;
}

function walkObject(
  value: object,
  depth: number,
  ancestors: Set<object>,
  state: WalkState,
): unknown {
  let changed = false;
  const out: Record<string, unknown> = {};
  // OWN enumerable string keys: what `JSON.stringify` writes and what the Postgres store keeps.
  for (const key of Object.keys(value)) {
    const read = readOnce(value, key);
    const item = read.value;
    // The key decides before the value is walked, so a credential under a redacted name is never
    // read further. `null` and `undefined` under one are KEPT: they hold no credential, and
    // redacting them would refuse the replay of a `{ resetToken: null }` that never carried one.
    const next =
      item !== undefined && item !== null && isRedactedKey(key)
        ? redact(state)
        : walk(item, depth + 1, ancestors, state);
    if (read.copy || next !== item) changed = true;
    out[key] = next;
  }
  return changed ? out : value;
}
