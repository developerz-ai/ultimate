// Single responsibility: the framework's ONE `JsonValue` declaration and `t.json()`, the validator
// that admits exactly the values `JSON.stringify` and a Postgres `jsonb` round-trip unchanged.
// Its own file for `money-value.ts`'s reason: it is a builtin whose SHAPE other packages alias.

import {
  type Check,
  fail,
  failWith,
  isPlainObject,
  makeSchema,
  pass,
  type Schema,
} from './builder';
import { expected } from './describe-value';
import type { SchemaNode } from './node';
import type { StandardIssue } from './standard';

/**
 * Any value JSON can carry. Readonly, because a parsed payload is data the handler reads; the copy
 * `t.json()` answers is its own, so nothing it holds is shared with the caller's input.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * How many containers `t.json()` lets nest. A FIXED bound, not an option: the walk recurses once
 * per level and `JSON.parse` builds 100 000 levels from 200 KB of brackets, so an unbounded walk
 * was a `RangeError` — a 500 — for any caller who sent one. 256 holds a rich-text document (each
 * list level is an array and an object) with room to spare. Narrower is `.refine()`'s job.
 */
export const JSON_MAX_DEPTH = 256;

const NUL = '\u0000';
/** A lone UTF-16 surrogate. `String#isWellFormed` is ES2024 and the lib is ES2023. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Why a string cannot be stored, or `undefined`. Both MEASURED against Postgres 17 through
 * `$1::text::jsonb`, the cast `@ultimat3/entity`'s `json()` column writes with: a NUL answers
 * `unsupported Unicode escape sequence`, a lone surrogate `invalid input syntax for type json`.
 * Passing either here moved the refusal to the row write, as a 500 with no field path.
 */
function unstorable(text: string): string | undefined {
  if (text.includes(NUL)) return 'that contains a NUL character (U+0000)';
  if (LONE_SURROGATE.test(text)) return 'that contains a lone UTF-16 surrogate';
  return undefined;
}

/** A path segment chain, materialised only for an issue: a copy per node is O(n × depth). */
interface At {
  readonly parent: At | readonly PropertyKey[];
  readonly segment: number;
}

function pathOf(at: At | readonly PropertyKey[]): PropertyKey[] {
  const segments: number[] = [];
  let cursor = at;
  while (!Array.isArray(cursor)) {
    const link = cursor as At;
    segments.push(link.segment);
    cursor = link.parent;
  }
  return [...(cursor as readonly PropertyKey[]), ...segments.reverse()];
}

interface Walk {
  readonly issues: StandardIssue[];
  /** The containers enclosing the current one: meeting one again is a cycle. */
  readonly open: Set<object>;
  /** A container already accepted, with its height, so a shared one is walked ONCE. */
  readonly done: Map<object, { readonly value: JsonValue; readonly height: number }>;
  /** A container already refused: its issues are reported, at the first position it was met. */
  readonly refused: Set<object>;
}

type Step = { readonly ok: true; readonly value: JsonValue; readonly height: number } | null;

const CYCLE = 'expected a JSON value, received a cycle (a reference back to an enclosing value)';
const NOT_PLAIN = 'expected a JSON value, received an object that is not a plain object or array';

function refuse(state: Walk, at: At | readonly PropertyKey[], message: string): null {
  state.issues.push({ message, path: pathOf(at) });
  return null;
}

function scalar(value: unknown, at: At | readonly PropertyKey[], state: Walk): Step {
  if (value === null || typeof value === 'boolean') return { ok: true, value, height: 0 };
  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? { ok: true, value, height: 0 }
      : refuse(state, at, expected('a JSON value', value));
  }
  if (typeof value === 'string') {
    const reason = unstorable(value);
    return reason === undefined
      ? { ok: true, value, height: 0 }
      : refuse(state, at, `${expected('a JSON value', value)} ${reason}`);
  }
  return refuse(state, at, expected('a JSON value', value));
}

function walk(value: unknown, at: At | readonly PropertyKey[], depth: number, state: Walk): Step {
  if (typeof value !== 'object' || value === null) return scalar(value, at, state);
  const array = Array.isArray(value);
  if (!array && !isPlainObject(value)) {
    // A Date names itself (`describeValue`); a Map, a Set or a class instance is "an object" there.
    return refuse(state, at, value instanceof Date ? expected('a JSON value', value) : NOT_PLAIN);
  }
  if (state.open.has(value)) return refuse(state, at, CYCLE);
  if (state.refused.has(value)) return null;
  const seen = state.done.get(value);
  const tooDeep = expected(`JSON nested at most ${JSON_MAX_DEPTH} levels deep`, value);
  if (seen !== undefined) {
    return depth + seen.height <= JSON_MAX_DEPTH
      ? { ok: true, ...seen }
      : refuse(state, at, tooDeep);
  }
  if (depth >= JSON_MAX_DEPTH) return refuse(state, at, tooDeep);

  state.open.add(value);
  const built = array ? walkArray(value, at, depth, state) : walkObject(value, at, depth, state);
  state.open.delete(value);
  if (built === null) {
    state.refused.add(value);
    return null;
  }
  state.done.set(value, built);
  return { ok: true, ...built };
}

type Built = { readonly value: JsonValue; readonly height: number } | null;

function walkArray(
  items: readonly unknown[],
  at: At | readonly PropertyKey[],
  depth: number,
  state: Walk,
): Built {
  const out: JsonValue[] = [];
  let height = 0;
  let ok = true;
  // An index loop, never `entries()` on a sparse array alone: a hole reads `undefined` and is
  // refused at its index, where `JSON.stringify` would have written `null` in silence.
  for (let index = 0; index < items.length; index += 1) {
    const step = walk(items[index], { parent: at, segment: index }, depth + 1, state);
    if (step === null) ok = false;
    else {
      out.push(step.value);
      height = Math.max(height, step.height);
    }
  }
  return ok ? { value: out, height: height + 1 } : null;
}

function walkObject(
  source: Record<string, unknown>,
  at: At | readonly PropertyKey[],
  depth: number,
  state: Walk,
): Built {
  // Null-prototype, for `recordSchema`'s reason: every key here is the caller's, and on a `{}`
  // literal `out['__proto__'] = …` re-prototypes the output instead of storing the key.
  const out: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  let height = 0;
  let ok = true;
  // The entry's POSITION is its path segment, never its key — the rule `recordSchema` states:
  // a key is caller data, and an issue path reaches the problem document and the log line.
  for (const [index, key] of Object.keys(source).entries()) {
    const link: At = { parent: at, segment: index };
    const reason = unstorable(key);
    if (reason !== undefined) {
      refuse(state, link, `expected an object key, received one ${reason}`);
      ok = false;
      continue;
    }
    const step = walk(source[key], link, depth + 1, state);
    if (step === null) ok = false;
    else {
      out[key] = step.value;
      height = Math.max(height, step.height);
    }
  }
  return ok ? { value: out, height: height + 1 } : null;
}

const checkJson: Check<JsonValue> = (value, path) => {
  const state: Walk = { issues: [], open: new Set(), done: new Map(), refused: new Set() };
  const step = walk(value, path, 0, state);
  if (step !== null) return pass(step.value);
  // Every refusal pushes its issue; the fallback only keeps a refusal from ever reading as success.
  return state.issues.length > 0
    ? failWith(state.issues)
    : fail(path, expected('a JSON value', value));
};

/**
 * Whether a value has a JSON SHAPE, one level deep — `node-fits.ts`'s question for a union
 * member. Not validation: a nested `undefined` still fits, and is refused by the parse after.
 */
export function isJsonShape(value: unknown): boolean {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  return Array.isArray(value) || isPlainObject(value);
}

const JSON_NODE: SchemaNode = Object.freeze({ kind: 'json' });

/**
 * `t.json()` as a free function, shipped beside the namespace member as `nullableSchema` is.
 * Every key is kept, `__proto__` and `constructor` included — a webhook body is somebody else's
 * document — and answered on a null-prototype copy, so no key reaches a prototype.
 */
export function jsonSchema(): Schema<JsonValue, JsonValue> {
  return makeSchema<JsonValue, JsonValue>(JSON_NODE, checkJson);
}
