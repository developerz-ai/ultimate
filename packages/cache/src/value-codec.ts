// The ONE encoding every cache tier stores a value in: JSON, plus tagged `Date`, `bigint`, `Map`
// and `Set`. One codec is what makes a hit the same shape whichever rung answered it — and since
// every tier stores TEXT, no two readers ever share one mutable object. Lives here, not in
// `@ultimat3/query`'s cursor codec: query is tier 3, and this package is tier 1.

import { renderThrowable } from '@ultimat3/core';
import { CacheValueUnencodableError } from './errors';

/** The member that marks a tagged value. Only this codec writes it; an app's own is escaped. */
const TAG = '$x';
/** `$x`, `$$x`, `$$$x`…: an app key that could be read as a tag, written with one more `$`. */
const ESCAPABLE = /^\$+x$/;
/** What an escaped app key looks like on the way back: two or more `$`. */
const ESCAPED = /^\$\$+x$/;
const DIGITS = /^-?\d+$/;

/**
 * The deepest a cached value may nest. `JSON.parse` with a reviver recurses, and overflows the
 * stack somewhere between 5k and 20k levels that `JSON.stringify` wrote without complaint — so a
 * deeper value was stored and then unreadable on every hit until its TTL. Refused at the write.
 */
export const MAX_CACHE_VALUE_DEPTH = 512;

/**
 * The longest `bigint` a cached value may hold, in characters. `BigInt(text)` is super-linear: a
 * million digits throws a `RangeError`, 300k take over a second. 4096 is far past any column type
 * (`numeric` aside) and costs microseconds.
 */
export const MAX_CACHE_BIGINT_DIGITS = 4096;

/**
 * Prefixed to every text this codec writes. No JSON text starts with `x`, so an unmarked entry —
 * a Redis value written by a pod from before the codec — is read with plain `JSON.parse`, and app
 * data that happens to look like a tag (`{"$x":"bigint","v":"12"}`) or an escape (`$$x`) is
 * handed back exactly as it was stored, never revived or renamed.
 */
export const CACHE_CODEC_MARK = 'x1:';

type Tagged = { readonly [TAG]: 'date' | 'bigint' | 'map' | 'set'; readonly v: unknown };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A copy with every tag-shaped key given one more `$`, or the object itself when it has none. */
const escapeKeys = (value: Record<string, unknown>): Record<string, unknown> => {
  const keys = Object.keys(value);
  if (!keys.some((key) => ESCAPABLE.test(key))) return value;
  return Object.fromEntries(keys.map((key) => [ESCAPABLE.test(key) ? `$${key}` : key, value[key]]));
};

const unescapeKeys = (value: Record<string, unknown>): Record<string, unknown> => {
  const keys = Object.keys(value);
  if (!keys.some((key) => ESCAPED.test(key))) return value;
  return Object.fromEntries(
    keys.map((key) => [ESCAPED.test(key) ? key.slice(1) : key, value[key]]),
  );
};

/**
 * `this[key]`, not `value`: `JSON.stringify` calls `Date#toJSON` BEFORE the replacer sees it, so
 * the argument is already a string — the holder still has the `Date`.
 */
function transform(holder: unknown, key: string, value: unknown): unknown {
  const raw =
    isRecord(holder) || Array.isArray(holder) ? (holder as Record<string, unknown>)[key] : value;
  if (raw instanceof Date) {
    return { [TAG]: 'date', v: Number.isNaN(raw.getTime()) ? null : raw.toISOString() };
  }
  if (typeof raw === 'bigint') {
    const digits = raw.toString();
    if (digits.length > MAX_CACHE_BIGINT_DIGITS) {
      throw new CacheCodecLimit(
        `a bigint of ${digits.length} characters, over the ${MAX_CACHE_BIGINT_DIGITS} a cache holds`,
      );
    }
    return { [TAG]: 'bigint', v: digits };
  }
  if (raw instanceof Map) return { [TAG]: 'map', v: [...raw.entries()] };
  if (raw instanceof Set) return { [TAG]: 'set', v: [...raw] };
  return isRecord(value) ? escapeKeys(value) : value;
}

/** A limit this codec refuses at, carried out of `JSON.stringify` to `encodeCacheValue`. */
class CacheCodecLimit {
  constructor(readonly reason: string) {}
}

/**
 * A replacer that knows how deep it is: every container it hands back is filed under its depth,
 * and `JSON.stringify` calls it with that container as `this` for each member — one map lookup
 * per node, no second walk. A cycle never reaches the cap: `JSON.stringify` refuses it first.
 */
const replacerWithDepth = (): ((this: unknown, key: string, value: unknown) => unknown) => {
  const depths = new WeakMap<object, number>();
  return function replace(this: unknown, key: string, value: unknown): unknown {
    const out = transform(this, key, value);
    if (typeof out !== 'object' || out === null) return out;
    const depth = (typeof this === 'object' && this !== null ? (depths.get(this) ?? 0) : 0) + 1;
    if (depth > MAX_CACHE_VALUE_DEPTH) {
      throw new CacheCodecLimit(
        `nested deeper than the ${MAX_CACHE_VALUE_DEPTH} levels a cache reads back`,
      );
    }
    depths.set(out, depth);
    return out;
  };
};

const isEntryList = (value: unknown): value is [unknown, unknown][] =>
  Array.isArray(value) && value.every((entry) => Array.isArray(entry) && entry.length === 2);

/** The tagged value back, or `undefined` when `value` is not one this codec wrote. */
const untag = (value: Record<string, unknown>): { readonly revived: unknown } | undefined => {
  const keys = Object.keys(value);
  if (keys.length !== 2 || !Object.hasOwn(value, TAG) || !Object.hasOwn(value, 'v')) return;
  const { v } = value as Tagged;
  switch (value[TAG]) {
    case 'date':
      return v === null || typeof v === 'string'
        ? { revived: new Date(v ?? Number.NaN) }
        : undefined;
    case 'bigint':
      // Length first: text past the cap was not written by `encodeCacheValue`, and `BigInt` on it
      // is the expensive call.
      return typeof v === 'string' && v.length <= MAX_CACHE_BIGINT_DIGITS && DIGITS.test(v)
        ? { revived: BigInt(v) }
        : undefined;
    case 'map':
      return isEntryList(v) ? { revived: new Map(v) } : undefined;
    case 'set':
      return Array.isArray(v) ? { revived: new Set(v) } : undefined;
    default:
      return undefined;
  }
};

/** Bottom-up, so a tagged value's members are already revived when the tag itself is read. */
const revive = (_key: string, value: unknown): unknown => {
  if (!isRecord(value)) return value;
  const tagged = untag(value);
  return tagged === undefined ? unescapeKeys(value) : tagged.revived;
};

/**
 * `payload` as the text a tier stores, marked with `CACHE_CODEC_MARK`. A cycle, a throwing
 * `toJSON`, nesting past `MAX_CACHE_VALUE_DEPTH` or a bigint past `MAX_CACHE_BIGINT_DIGITS` is
 * `X_CACHE_VALUE_UNENCODABLE`, naming the key and the tier: what is written is always readable.
 */
export function encodeCacheValue(payload: unknown, at: { key: string; tier: string }): string {
  try {
    // `?? 'null'`: a top-level `undefined` or function is no JSON text at all.
    return `${CACHE_CODEC_MARK}${JSON.stringify(payload, replacerWithDepth()) ?? 'null'}`;
  } catch (error) {
    const reason = error instanceof CacheCodecLimit ? error.reason : renderThrowable(error);
    throw new CacheValueUnencodableError({ ...at, reason });
  }
}

/**
 * The inverse. Marked text is revived — only an object of exactly `{ $x, v }` with a tag this
 * codec knows. Unmarked text predates the codec and is plain `JSON.parse`. Throws what
 * `JSON.parse` throws; a tier reading text it did not write decides what a corrupt entry means.
 */
export function decodeCacheValue(text: string): unknown {
  if (!text.startsWith(CACHE_CODEC_MARK)) return JSON.parse(text);
  return JSON.parse(text.slice(CACHE_CODEC_MARK.length), revive);
}
