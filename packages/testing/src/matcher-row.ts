// Single responsibility: equality over a repository ROW, own properties included. `@ultimat3/entity`
// answers a `.sealed()` column as a server-only property — own, readable by name, not enumerable —
// and `toEqual` walks enumerable properties only: `expect(row).toEqual({ …, password })` fails with
// an EMPTY diff (both sides print alike), and `toEqual(otherRow)` cannot see a wrong secret at all.
// `toEqualRow` compares what the row HOLDS, and names what differs without printing a secret.

import { describeValue, renderCauseValue } from '@ultimat3/core';
import type { MatcherResult } from './matcher-result';

const isPlain = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * `value` with every own property of every plain object in it made enumerable — the form
 * `Bun.deepEquals` can compare. A `Date`, a `Map` or a class instance is left as it is: equality
 * already knows them, and none of them is a row. `seen` maps an object to its copy, so a cycle
 * comes back as a cycle instead of a stack overflow.
 */
const reveal = (value: unknown, seen: Map<object, unknown>): unknown => {
  if (Array.isArray(value)) {
    const known = seen.get(value);
    if (known !== undefined) return known;
    const out: unknown[] = [];
    seen.set(value, out);
    for (const item of value) out.push(reveal(item, seen));
    return out;
  }
  if (!isPlain(value)) return value;
  const known = seen.get(value);
  if (known !== undefined) return known;
  const out: Record<string, unknown> = {};
  seen.set(value, out);
  for (const key of Object.getOwnPropertyNames(value)) {
    // `defineProperty`, never assignment: a key named `__proto__` must stay a key.
    Object.defineProperty(out, key, {
      value: reveal(value[key], seen),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
};

const same = (received: unknown, expected: unknown): boolean =>
  Bun.deepEquals(reveal(received, new Map()), reveal(expected, new Map()));

const serverOnly = (row: unknown, key: string): boolean =>
  isPlain(row) && Object.getOwnPropertyDescriptor(row, key)?.enumerable === false;

/**
 * One line per top-level property that differs. A server-only property is NAMED and nothing more —
 * not its value and not its length: the message lands in a CI log, and that property is a secret.
 */
const differences = (received: unknown, expected: unknown): readonly string[] => {
  if (!isPlain(received) || !isPlain(expected)) {
    return [`received ${describeValue(received)}, expected ${describeValue(expected)}`];
  }
  const keys = new Set([
    ...Object.getOwnPropertyNames(received),
    ...Object.getOwnPropertyNames(expected),
  ]);
  const lines: string[] = [];
  for (const key of keys) {
    if (same(received[key], expected[key])) continue;
    if (!serverOnly(received, key) && !serverOnly(expected, key)) {
      lines.push(
        `${key}: received ${renderCauseValue(received[key])}, expected ${renderCauseValue(expected[key])}`,
      );
    } else if (!Object.hasOwn(expected, key)) {
      lines.push(`${key} (server-only): the row holds one and the expected value names none`);
    } else if (!Object.hasOwn(received, key)) {
      lines.push(`${key} (server-only): the expected value holds one and the row has none`);
    } else {
      lines.push(`${key} (server-only): differs — a server-only value is never printed`);
    }
  }
  return lines;
};

export function rowEquality(received: unknown, expected: unknown): MatcherResult {
  const pass = same(received, expected);
  return {
    pass,
    message: () =>
      pass
        ? 'expected the row not to equal the given one, own non-enumerable properties included'
        : `expected the row to equal the given one, own non-enumerable properties included — ${differences(received, expected).join('; ')}`,
  };
}
