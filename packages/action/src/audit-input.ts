/**
 * One job: turn an `AuditRecord.input` into something a durable sink may write down — redacted
 * through core's own table, and representable as JSON on every path. Both halves are safety, not
 * formatting: a stored credential is a leak, and a sink that throws on the caller's input fails an
 * invocation whose handler has already committed.
 */

import { isRedactedKey, isSecret, REDACTED } from '@ultimat3/core';

/**
 * What a value this cannot represent becomes. A NAME and never `null`: `JSON.stringify` writes
 * `null` for `NaN` and `±Infinity` and drops a function entirely, so an auditor reading the row
 * could not tell "the field was absent" from "the field held something unwritable".
 */
export const UNREPRESENTABLE = '[unrepresentable]';

/**
 * How deep the walk goes. The input is schema-parsed, so its shape is the app's declaration — but
 * `t.record` and a recursive schema have no depth of their own, and an overflow HERE lands in the
 * sink, after the handler committed. Anything past this is `UNREPRESENTABLE`, which is the honest
 * answer: it was there and this row does not carry it.
 */
export const AUDIT_INPUT_MAX_DEPTH = 12;

/**
 * `undefined` in, `undefined` out — an input that never parsed is a row with no input, not a row
 * whose input was null.
 *
 * A cycle is CUT rather than raised on, and that is a cost decision as much as a correctness one:
 * `JSON.stringify` over a self-referential value takes ~4.6s in Bun 1.4 before it throws, so
 * leaving the detection to the serializer stalls the audited path whether or not the throw is
 * caught. The ancestor set is the path, not everything seen — a value appearing twice as siblings
 * is repetition and is written twice, exactly as `JSON.stringify` writes it.
 *
 * **`toJSON` is never called.** It is app code inside the frame that owes the caller a record, and
 * one that throws is the second failure `jsonResult` already names; a `Map`, a `Set` and a `URL`
 * therefore walk as their own enumerable keys, which is what `JSON.stringify` makes of them too.
 */
export function auditableInput(value: unknown): unknown {
  if (value === undefined) return undefined;
  return walk(value, 0, new Set());
}

function walk(value: unknown, depth: number, ancestors: Set<object>): unknown {
  if (value === null) return null;
  const kind = typeof value;
  if (kind === 'string' || kind === 'boolean') return value;
  if (kind === 'number') return Number.isFinite(value) ? value : UNREPRESENTABLE;
  // `bigint`, `function`, `symbol`, and `undefined` reached through an array hole.
  if (kind !== 'object') return UNREPRESENTABLE;

  const object = value as object;
  if (isSecret(object)) return REDACTED;
  if (object instanceof Date) {
    return Number.isNaN(object.getTime()) ? UNREPRESENTABLE : object.toISOString();
  }
  if (depth >= AUDIT_INPUT_MAX_DEPTH || ancestors.has(object)) return UNREPRESENTABLE;

  ancestors.add(object);
  try {
    if (Array.isArray(object)) {
      return object.map((item) => walk(item, depth + 1, ancestors));
    }
    const out: Record<string, unknown> = {};
    // `Object.entries`, so only OWN enumerable keys are read: a prototype member is not this
    // record's data, and reading one would put `Object.prototype`'s members in every audit row.
    for (const [key, item] of Object.entries(object)) {
      // The key decides before the value does, so a credential under a redacted name is never
      // walked at all — `isRedactedKey` is core's, the same table `defineEnv({ secret: true })`
      // extends, so a value that is `[redacted]` in a log line cannot be plaintext in a table.
      if (isRedactedKey(key)) out[key] = REDACTED;
      else if (item !== undefined) out[key] = walk(item, depth + 1, ancestors);
    }
    return out;
  } finally {
    ancestors.delete(object);
  }
}
