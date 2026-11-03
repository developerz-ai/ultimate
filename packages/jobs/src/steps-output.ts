// What `step.run` answers: the JSON form of what the body returned, on the first run as on a
// replay. The type states it and `jsonForm` produces it, so a body reading a `Date` off a step
// result fails at compile time, and if forced, on attempt 1 rather than on the first resume.

import { isJsonObject, isUltimateError, jsonbRefusal, renderThrowable } from '@ultimat3/core';
import { StepOutputUnserializableError } from './errors-steps';

type Callable = ((...args: never[]) => unknown) | (abstract new (...args: never[]) => unknown);

/** The part of a member's type JSON leaves out: `{ a: undefined }` writes `{}`. */
type NonJson<V> = V extends void ? V : V extends symbol | Callable ? V : never;

/** `unknown` and `any` promise nothing about absence, so they stay what they are. */
type IsOpen<V> = unknown extends V ? true : false;

type AlwaysThere<V> = IsOpen<V> extends true ? true : [NonJson<V>] extends [never] ? true : false;

type SometimesThere<V> =
  AlwaysThere<V> extends true ? false : [Exclude<V, NonJson<V>>] extends [never] ? false : true;

type JsonMembers<T> = {
  [K in keyof T as K extends symbol
    ? never
    : AlwaysThere<T[K]> extends true
      ? K
      : never]: StepOutput<T[K]>;
} & {
  [K in keyof T as K extends symbol
    ? never
    : SometimesThere<T[K]> extends true
      ? K
      : never]?: StepOutput<Exclude<T[K], NonJson<T[K]>>>;
};

type Flat<T> = { [K in keyof T]: T[K] };

/** Instances whose state lives in slots or on the prototype: `JSON.stringify` writes `{}`. */
type WritesNoMembers =
  | ReadonlyMap<unknown, unknown>
  | ReadonlySet<unknown>
  | RegExp
  | ArrayBuffer
  | DataView;

/** `new Uint8Array([1])` writes `{"0":1}`, an object keyed by index, never an array. */
type TypedArray = Exclude<ArrayBufferView, DataView>;

type JsonOf<T> = T extends string | number | boolean | null
  ? T
  : T extends bigint
    ? never
    : T extends undefined
      ? null
      : T extends void
        ? T
        : T extends symbol | Callable
          ? null
          : T extends { toJSON(...args: never[]): infer R }
            ? StepOutput<R>
            : T extends WritesNoMembers
              ? Record<string, never>
              : T extends Error
                ? Flat<JsonMembers<Omit<T, keyof Error>>>
                : T extends TypedArray
                  ? Record<string, number>
                  : T extends readonly unknown[]
                    ? { [K in keyof T]: StepOutput<T[K]> }
                    : T extends object
                      ? Flat<JsonMembers<T>>
                      : T;

/**
 * The JSON form of `T`, exactly what `JSON.parse(JSON.stringify(value))` leaves. Primitives and
 * brands kept; a `Date` or anything with a `toJSON()` becomes what that returns; function and
 * symbol members dropped; `undefined` at the top or in an array is `null`, on a member the member
 * is absent; `readonly` and optionality kept. `unknown` stays `unknown`, `void` stays `void`.
 * `bigint` is `never`: the value raises `X_STEP_OUTPUT_UNSERIALIZABLE` instead of arriving, as do
 * `NaN`, an infinity, an invalid `Date` and text `jsonb` refuses, which the type cannot see.
 */
export type StepOutput<T> = unknown extends T ? T : JsonOf<T>;

/**
 * The value both attempts see. One stringify and one parse per EXECUTED step, none on a replay; a
 * step persists a cursor, not a page, which is what keeps that cheap (`backfill()`'s rule).
 *
 * `JSON.stringify` answers `undefined` for `undefined`, a function and a symbol, and every store
 * writes those as `null` (`JSON.stringify(output ?? null)`), so that is the stored form.
 *
 * A number `JSON.stringify` would write as `null` is refused here rather than typed `number` and
 * answered `null`. Text `jsonb` refuses is refused on every store: Postgres alone raised it, from
 * `put`, with nothing recorded, so the body ran again on each attempt where memory ran it once.
 */
export function jsonForm<T>(value: T, at: { job: string; step: string }): StepOutput<T> {
  const refused = (reason: string) => new StepOutputUnserializableError({ ...at, reason });
  let text: string | undefined;
  try {
    text = JSON.stringify(value, function screen(this: unknown, key: string, written: unknown) {
      if (typeof written === 'number' && !Number.isFinite(written)) {
        throw refused('a NaN or an infinity, which JSON writes as null');
      }
      // Only the holder still has the `Date`: its `toJSON` has already answered `null`.
      if (written === null && (this as Record<string, unknown>)[key] instanceof Date) {
        throw refused('an invalid Date, which JSON writes as null');
      }
      return written;
    });
  } catch (error) {
    if (isUltimateError(error) && error.code === 'X_STEP_OUTPUT_UNSERIALIZABLE') throw error;
    throw refused(renderThrowable(error));
  }
  if (text === undefined) return null as StepOutput<T>;
  const refusal = jsonbRefusal(text);
  if (refusal !== undefined) throw refused(refusal);
  return JSON.parse(text, inStoredOrder) as StepOutput<T>;
}

const UTF8 = new TextEncoder();

/** `jsonb`'s own key order: shorter first by bytes, then bytewise. */
function storedKeyOrder(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return a.length - b.length;
  for (let at = 0; at < a.length; at += 1) {
    const difference = (a[at] ?? 0) - (b[at] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * A reviver: Postgres hands keys back in `jsonb`'s order and memory in the body's, so a body reading
 * `Object.keys` saw two runs. Every attempt on every store now reads this one. Integer-like keys
 * still come first, on both paths, because a JS object puts them there. `fromEntries` defines, so a
 * `__proto__` key stays data.
 */
function inStoredOrder(_key: string, value: unknown): unknown {
  if (!isJsonObject(value)) return value;
  const entries = Object.entries(value);
  if (entries.length < 2) return value;
  const keyed = entries.map((entry) => ({ entry, bytes: UTF8.encode(entry[0]) }));
  keyed.sort((a, b) => storedKeyOrder(a.bytes, b.bytes));
  return Object.fromEntries(keyed.map(({ entry }) => entry));
}
