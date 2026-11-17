// The resolved `AppConfig` as JSON an operator may paste into an issue: every credential-named key
// and every `secret()` value replaced, a URL's password cut out of its userinfo. Both rules are
// core's — `isRedactedKey` (the logger's) and `redactUrlPassword` — so a field hidden there is here.

import { isRedactedKey, isSecret, REDACTED, redactUrlPassword } from '@ultimat3/core';
import type { JsonValue } from './output';

/** Past this depth a config is not data an operator wrote; the walk stops rather than recurse. */
const MAX_DEPTH = 16;

export function redactConfigValue(value: unknown, depth = 0): JsonValue {
  if (isSecret(value)) return REDACTED;
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return redactUrlPassword(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'boolean') return value;
  // A config may carry a callback (a `health` probe, a `resolve` hook): named, never its source.
  if (typeof value === 'function') return '[function]';
  if (typeof value === 'bigint' || typeof value === 'symbol') return String(value);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value instanceof RegExp) return String(value);
  if (depth >= MAX_DEPTH) return '[nested too deep]';
  if (Array.isArray(value)) return value.map((item: unknown) => redactConfigValue(item, depth + 1));
  const out: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    // `defineProperty`, never `out[key] =`: a config key is the app's string, and `__proto__`
    // assigned would re-prototype the record instead of adding a field.
    Object.defineProperty(out, key, {
      value: isRedactedKey(key) ? REDACTED : redactConfigValue(item, depth + 1),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}
