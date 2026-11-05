/**
 * `seededDraw(seed, run)`: the generated inputs the contract step's exercise assertion sends.
 * A number in, the same values out — never `Math.random`, never the clock — so a red run replays
 * from the test's name alone. Runs 0-3 sit on the IR's bounds; later runs draw inside them.
 */

import type { SchemaNode } from './node';
import type { Draw } from './sample-draw';
import {
  minimalNumber,
  minimalString,
  owedItems,
  SAMPLE_ITEMS_MAX,
  satisfiesPattern,
} from './sample-draw';

/** Runs below this one are boundaries, not draws. */
export const BOUNDARY_RUNS = 4;

/**
 * Multibyte on purpose: the text a handler mishandles is the text a test never typed. Every entry
 * is one code point, the unit `minLength`/`maxLength` count in (`char-count.ts`), and none is a
 * control character or a lone surrogate, which a validator or a database refuses on its own.
 */
const ALPHABET = [
  'a',
  'z',
  'Q',
  '0',
  '7',
  ' ',
  '-',
  '_',
  'é',
  'ß',
  'ж',
  'ع',
  '漢',
  '字',
  '🙂',
  '👍',
];

/** An unbounded string's length is this past its floor; a bound past the cap is clamped to it. */
const STRING_SPAN = 24;
const STRING_CAP = 4096;

/** An unbounded number's range, both directions. A whole number stays a 32-bit one. */
const NUMBER_SPAN = 1_000_000;
const INTEGER_HIGH = 2 ** 31 - 1;

/** An array draws at most this many items past what `minItems` owes. */
const ITEMS_SPAN = 4;

/** mulberry32: 32 bits of state, a uniform float in [0, 1) per call. */
function generator(state: number): () => number {
  let s = state >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = s;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Which side of every bound a boundary run takes, and whether it reaches for the optional parts. */
interface Boundary {
  readonly high: boolean;
  readonly optional: boolean;
  readonly nulls: boolean;
}

const BOUNDARIES: readonly Boundary[] = [
  { high: false, optional: false, nulls: false },
  { high: true, optional: true, nulls: false },
  { high: false, optional: true, nulls: true },
  { high: true, optional: false, nulls: false },
];

const whole = (n: number, integer: boolean, up: boolean): number =>
  integer ? (up ? Math.ceil(n) : Math.floor(n)) : n;

function numberRange(node: SchemaNode): readonly [number, number] {
  const integer = node.integer === true;
  const low = whole(node.minimum ?? (integer ? -INTEGER_HIGH : -NUMBER_SPAN), integer, true);
  const high = whole(node.maximum ?? (integer ? INTEGER_HIGH : NUMBER_SPAN), integer, false);
  return [low, high];
}

function lengthRange(node: SchemaNode): readonly [number, number] {
  const low = Math.min(node.minLength ?? 0, STRING_CAP);
  const high = Math.min(node.maxLength ?? low + STRING_SPAN, STRING_CAP);
  return [low, Math.max(low, high)];
}

/**
 * The draw for one run of one seed. `seed` is the caller's: `@ultimat3/action` and
 * `@ultimat3/query` hand it `fnv1a(<name>)`, which this tier cannot import.
 */
export function seededDraw(seed: number, run: number): Draw {
  const next = generator((seed ^ Math.imul(run + 1, 0x9e3779b1)) >>> 0);
  const between = (low: number, high: number): number =>
    low + Math.floor(next() * (high - low + 1));
  const edge = run >= 0 && run < BOUNDARY_RUNS ? BOUNDARIES[run] : undefined;

  const text = (node: SchemaNode): string => {
    const [low, high] = lengthRange(node);
    const length = edge === undefined ? between(low, high) : edge.high ? high : low;
    const chars = Array.from({ length }, () => ALPHABET[between(0, ALPHABET.length - 1)] ?? 'a');
    const value = chars.join('');
    // A regex cannot be inverted: a drawn value that misses it would test only the validator, so
    // the one value the walk can build for it stands in (and `sampleGaps` reports when it cannot).
    return satisfiesPattern(node, value) ? value : minimalString(node);
  };

  const number = (node: SchemaNode): number => {
    const [low, high] = numberRange(node);
    if (low > high) return minimalNumber(node);
    if (edge !== undefined) return edge.high ? high : low;
    if (node.integer === true) return between(low, high);
    // Two decimals, clamped: a float draw must not step past the bound it was drawn under.
    const drawn = Math.round((low + next() * (high - low)) * 100) / 100;
    return Math.min(high, Math.max(low, drawn));
  };

  return {
    string: text,
    number,
    boolean: () => (edge === undefined ? next() < 0.5 : edge.high),
    include: () => (edge === undefined ? next() < 0.5 : edge.optional),
    items: (node) => {
      const owed = owedItems(node) ?? 0;
      const cap = Math.max(
        owed,
        Math.min(node.maxItems ?? owed + ITEMS_SPAN, owed + ITEMS_SPAN * 2, SAMPLE_ITEMS_MAX),
      );
      if (edge !== undefined) return edge.high ? cap : owed;
      return between(owed, Math.min(cap, owed + ITEMS_SPAN));
    },
    member: <T>(choices: readonly T[]): T | undefined =>
      choices.length === 0
        ? undefined
        : choices[edge === undefined ? between(0, choices.length - 1) : run % choices.length],
    nullable: () => (edge === undefined ? next() < 0.25 : edge.nulls),
  };
}
