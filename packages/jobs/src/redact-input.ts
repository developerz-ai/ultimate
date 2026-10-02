// A job's stored payload as an operator may READ it: every key the app declared secret —
// `redactKeys`, which `defineEnv()` feeds and the logger already obeys — replaced before the
// value leaves this package. One list, so a field hidden in the logs is hidden in `x jobs show`.

import { isRedactedKey, isSecret, REDACTED } from '@ultimat3/core';

/** Deep enough for any payload that is a pointer and not a record; past it the subtree is cut. */
const MAX_DEPTH = 8;

export function redactInput(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (isSecret(value)) return REDACTED;
  if (depth >= MAX_DEPTH) return '[depth-limit]';
  if (Array.isArray(value)) return value.map((entry) => redactInput(entry, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    // `defineProperty`, never assignment: a payload key named `__proto__` must stay a key.
    Object.defineProperty(out, key, {
      value: isRedactedKey(key) ? REDACTED : redactInput(entry, depth + 1),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}
