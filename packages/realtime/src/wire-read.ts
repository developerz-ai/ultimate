// The decoder's primitives: every field a frame carries is read through one of these, and every
// refusal is `X_PROTOCOL_VERSION` with the field named. Shared by `sync-protocol.ts` and
// `wire-channel.ts`, so the channel frames are held to the same ceilings as every other kind.

import { isJsonObject, type JsonObject, type JsonValue } from './json';
import { ProtocolVersionError } from './page-errors';
import { FRAME_LIMITS, PROTOCOL_VERSION } from './wire-version';

export function fail(detail: string): ProtocolVersionError {
  return new ProtocolVersionError({ got: detail, expected: PROTOCOL_VERSION, detail });
}

export function str(obj: JsonObject, key: string): string {
  const value = obj[key];
  if (typeof value !== 'string') throw fail(`field "${key}" must be a string`);
  return value;
}

export function nullableStr(obj: JsonObject, key: string): string | null {
  const value = obj[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw fail(`field "${key}" must be a string or null`);
  return value;
}

export function num(obj: JsonObject, key: string): number {
  const value = obj[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw fail(`field "${key}" must be a finite number`);
  }
  return value;
}

export function pick<T extends string>(obj: JsonObject, key: string, allowed: readonly T[]): T {
  const value = str(obj, key);
  const found = allowed.find((candidate) => candidate === value);
  if (found === undefined) throw fail(`field "${key}" must be one of ${allowed.join('|')}`);
  return found;
}

/**
 * An array field, with the ceiling the caller had to choose. `max` is required rather than
 * defaulted: a new list field on a new frame is a new thing an authenticated socket can make
 * arbitrarily large, and a default would let one ship without anyone deciding its size.
 */
export function list(obj: JsonObject, key: string, max: number, label = key): JsonValue[] {
  const value = obj[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw fail(`field "${label}" must be an array`);
  if (value.length > max) {
    throw fail(`field "${label}" carries ${value.length} entries, over the limit of ${max}`);
  }
  return value;
}

/**
 * A client-supplied value, walked ITERATIVELY to its limits. Iteratively because the thing being
 * refused is a stack overflow: `queryHash` -> `canonicalJson` recurses over exactly this value, so a
 * depth check that recursed would be the same crash one frame earlier.
 */
export function bounded(value: JsonValue, label: string): JsonValue {
  const stack: { node: JsonValue; depth: number }[] = [{ node: value, depth: 1 }];
  let seen = 0;
  while (stack.length > 0) {
    // `pop` cannot answer undefined here — the loop guard is the length — and the check is what
    // makes that readable to the compiler without a cast.
    const next = stack.pop();
    if (next === undefined) break;
    seen += 1;
    if (seen > FRAME_LIMITS.inputNodes) {
      throw fail(`field "${label}" holds more than ${FRAME_LIMITS.inputNodes} values`);
    }
    if (next.depth > FRAME_LIMITS.inputDepth) {
      throw fail(`field "${label}" is nested deeper than ${FRAME_LIMITS.inputDepth}`);
    }
    if (next.node === null || typeof next.node !== 'object') continue;
    const children = Array.isArray(next.node) ? next.node : Object.values(next.node);
    for (const child of children) stack.push({ node: child, depth: next.depth + 1 });
  }
  return value;
}

export function object(value: unknown): JsonObject {
  if (!isJsonObject(value)) throw fail('expected a JSON object');
  return value;
}
