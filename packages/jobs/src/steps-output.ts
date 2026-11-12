// What `step.run` answers: the JSON form of what the body returned, on the first run as on a
// replay. The type states it and `jsonForm` produces it, so a body reading a `Date` off a step
// result fails at compile time, and if forced, on attempt 1 rather than on the first resume. It
// also holds the byte ceiling a stored output may reach.

import {
  finiteCount,
  isJsonObject,
  isUltimateError,
  jsonbRefusal,
  logger,
  renderThrowable,
} from '@ultimat3/core';
import type { JsonValue } from '@ultimat3/schema';
import { StepOutputTooLargeError, StepOutputUnserializableError } from './errors-steps';

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
export type StepOutput<T> = unknown extends T
  ? T
  : // Already JSON, so the round trip changes nothing. Checked first: `JsonValue` is recursive, and
    // walking it member by member never bottoms out (TS2589).
    [T] extends [JsonValue]
    ? T
    : JsonOf<T>;

/**
 * The most JSON bytes one `step.run` output should hold unless its job declares `stepOutputMax`.
 * Every attempt hydrates EVERY output of its run (`steps.ts`): 1,000 steps of 1 MB is a gigabyte
 * read on each retry. A step keeps a key or a cursor; the payload lives in storage (`export`,
 * `backfill`). Past it a job that declared nothing is WARNED and the output stored — refusing by
 * default would break a shipped job on a minor; a job that declares `stepOutputMax` is refused.
 */
export const STEP_OUTPUT_MAX_BYTES = 256 * 1_024;

/** The byte ceiling a runner holds a `step.run` output to, and what passing it does. */
export interface StepOutputCeiling {
  readonly maxBytes: number;
  /** Declared by the job (`stepOutputMax`): past it, refused. The default only warns. */
  readonly refuses: boolean;
}

/** The ceiling a runner enforces: the declared one, screened as a whole count of bytes, or the default. */
export const stepOutputCeiling = (declared: number | undefined): StepOutputCeiling => ({
  maxBytes: finiteCount('step.run', 'stepOutputMaxBytes', declared ?? STEP_OUTPUT_MAX_BYTES, 1),
  refuses: declared !== undefined,
});

/** A UTF-8 character is at most 3 bytes per UTF-16 unit (a pair is 4 bytes for 2 units). */
const MAX_UTF8_BYTES_PER_UNIT = 3;

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
 *
 * `ceiling` — a `step.run`'s, never a waited event's, which is the publisher's payload — measures
 * the UTF-8 bytes of JSON before anything is stored: past it, `X_STEP_OUTPUT_TOO_LARGE`, thrown
 * when declared, logged once per job and step when the default.
 */
export function jsonForm<T>(
  value: T,
  at: { job: string; step: string },
  ceiling?: StepOutputCeiling,
): StepOutput<T> {
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
  if (ceiling !== undefined) holdToCeiling(text, ceiling, at);
  return JSON.parse(text, inStoredOrder) as StepOutput<T>;
}

const UTF8 = new TextEncoder();

/** Job+step pairs already warned in this process. Bounded: emptied when full, so it re-warns. */
const warned = new Set<string>();
const WARNED_MAX = 1_024;

/** Encodes only when the text COULD be over: the common small output pays one length read. */
function holdToCeiling(
  text: string,
  ceiling: StepOutputCeiling,
  at: { job: string; step: string },
): void {
  const { maxBytes } = ceiling;
  if (text.length * MAX_UTF8_BYTES_PER_UNIT <= maxBytes) return;
  const bytes = UTF8.encode(text).byteLength;
  if (bytes <= maxBytes) return;
  const error = new StepOutputTooLargeError({ ...at, bytes, maxBytes });
  if (ceiling.refuses) throw error;
  const key = `${at.job}\u0000${at.step}`;
  if (warned.has(key)) return;
  if (warned.size >= WARNED_MAX) warned.clear();
  warned.add(key);
  logger.warn('jobs.step.output-too-large', {
    code: error.code,
    job: at.job,
    step: at.step,
    bytes,
    maxBytes,
    cause: error.cause,
    fix: error.fix,
  });
}

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
