// Single responsibility: what a failure bundle may keep of a value — every key the app declared
// secret (`redactKeys`), every `Secret` and every field a schema already masked, replaced by
// `REDACTED` and LISTED by path, so `x repro` can say which fields it had to invent.

import { isRedactedKey } from './logger';
import { isSecret, REDACTED } from './secret';

/** Deep enough for any input that is a request and not a document; past it the subtree is cut. */
const MAX_DEPTH = 8;

export interface CapturedValue {
  readonly value: unknown;
  /** Dotted paths (`card.pan`, `items[]`) whose value is `REDACTED` in `value`. */
  readonly masked: readonly string[];
}

const join = (at: string, key: string): string => (at === '' ? key : `${at}.${key}`);

function walk(value: unknown, at: string, depth: number, masked: string[]): unknown {
  if (value === REDACTED || isSecret(value)) {
    masked.push(at === '' ? '(the value)' : at);
    return REDACTED;
  }
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DEPTH) return '[depth-limit]';
  if (Array.isArray(value)) return value.map((entry) => walk(entry, `${at}[]`, depth + 1, masked));
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const path = join(at, key);
    const kept = isRedactedKey(key)
      ? walk(REDACTED, path, depth + 1, masked)
      : walk(entry, path, depth + 1, masked);
    // `defineProperty`, never assignment: an input key named `__proto__` must stay a key.
    Object.defineProperty(out, key, {
      value: kept,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/**
 * A JSON-safe copy of `value` with every secret masked and listed. `value` may already carry
 * `REDACTED` where a schema's `.sensitive()` masked it (`maskSensitive`); those are listed too.
 * Paths are deduplicated: one masked field in every element of a list is one path, `items[].pan`.
 */
export function captureValue(value: unknown): CapturedValue {
  const masked: string[] = [];
  const kept = walk(value, '', 0, masked);
  return { value: kept, masked: [...new Set(masked)] };
}
