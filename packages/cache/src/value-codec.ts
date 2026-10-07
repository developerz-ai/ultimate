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
function replace(this: unknown, key: string, value: unknown): unknown {
  const raw =
    isRecord(this) || Array.isArray(this) ? (this as Record<string, unknown>)[key] : value;
  if (raw instanceof Date) {
    return { [TAG]: 'date', v: Number.isNaN(raw.getTime()) ? null : raw.toISOString() };
  }
  if (typeof raw === 'bigint') return { [TAG]: 'bigint', v: raw.toString() };
  if (raw instanceof Map) return { [TAG]: 'map', v: [...raw.entries()] };
  if (raw instanceof Set) return { [TAG]: 'set', v: [...raw] };
  return isRecord(value) ? escapeKeys(value) : value;
}

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
      return typeof v === 'string' && DIGITS.test(v) ? { revived: BigInt(v) } : undefined;
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
 * `payload` as the text a tier stores. A cycle or a throwing `toJSON` is
 * `X_CACHE_VALUE_UNENCODABLE`, naming the key and the tier — never the bare `TypeError`.
 */
export function encodeCacheValue(payload: unknown, at: { key: string; tier: string }): string {
  try {
    // `?? 'null'`: a top-level `undefined` or function is no JSON text at all.
    return JSON.stringify(payload, replace) ?? 'null';
  } catch (error) {
    throw new CacheValueUnencodableError({ ...at, reason: renderThrowable(error) });
  }
}

/**
 * The inverse. Plain JSON written before this codec existed decodes as it always did — only an
 * object of exactly `{ $x, v }` with a tag this codec knows is revived. Throws what `JSON.parse`
 * throws; a tier reading text it did not write decides what a corrupt entry means.
 */
export function decodeCacheValue(text: string): unknown {
  return JSON.parse(text, revive);
}
