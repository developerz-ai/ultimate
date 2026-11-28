// The resolved `AppConfig` as JSON an operator may paste into an issue: every credential-named key
// and every `secret()` value replaced, a URL's password cut out of its userinfo — a `proxy` URL's
// whole userinfo. The rules are core's (`isRedactedKey`, `redactUrlPassword`, `replaceUrlUserinfo`).

import {
  isRedactedKey,
  isSecret,
  REDACTED,
  redactUrlPassword,
  replaceUrlUserinfo,
} from '@ultimat3/core';
import type { JsonValue } from './output';

/** Past this depth a config is not data an operator wrote; the walk stops rather than recurse. */
const MAX_DEPTH = 16;

/**
 * A proxy URL carries its credential in the USER as often as the password (`http://sk-token@egress`),
 * so `outbound.proxy` — any `proxy` key — loses the whole userinfo, as core's boot line shows it.
 */
const redactedEntry = (key: string, item: unknown, depth: number): JsonValue => {
  if (isRedactedKey(key)) return REDACTED;
  if (key === 'proxy' && typeof item === 'string') return replaceUrlUserinfo(item, () => REDACTED);
  return redactConfigValue(item, depth + 1);
};

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
      value: redactedEntry(key, item, depth),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}
