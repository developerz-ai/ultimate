/**
 * The choices a sample walk delegates, and the minimal answer to each. One walker (`sample.ts`)
 * takes a `Draw`, so the contract step's generated inputs and the policy assertion's single sample
 * share every rule about what a node accepts; only the choices differ.
 */

import { charCount } from './char-count';
import type { SchemaFormat, SchemaNode } from './node';
import { patternSamples } from './sample-pattern';

/** Every choice a walk makes that its node leaves open. Answers stay inside the node's own bounds. */
export interface Draw {
  /** An unformatted string within `minLength`/`maxLength` (formats are `BY_FORMAT`'s, never drawn). */
  string(node: SchemaNode): string;
  /** A number within `minimum`/`maximum`, whole when `integer`. */
  number(node: SchemaNode): number;
  boolean(): boolean;
  /** Whether an optional or defaulted key is sent at all. */
  include(key: string): boolean;
  /** How many items an array sample holds, never below what `minItems` owes. */
  items(node: SchemaNode): number;
  /** One of an enum's values or a union's members; `undefined` only for an empty list. */
  member<T>(choices: readonly T[]): T | undefined;
  /** Whether a nullable node answers `null`. */
  nullable(node: SchemaNode): boolean;
}

/** Version 4, variant 1 — the shape `t.uuid` insists on, and no byte of it means anything. */
const SAMPLE_UUID = '00000000-0000-4000-8000-000000000000';

/** Short, and valid under `t.slug`'s and `t.cursor`'s patterns as well as bare `t.string`. */
export const SAMPLE_STRING = 'sample';

/**
 * One entry per `SchemaFormat`, exhaustively — a new format is a type error here rather than a
 * silent `'sample'` that fails its own validator. The ONE table both draws read: a mutated uuid
 * tests nothing but the validator, so a seeded draw never varies a format value.
 */
export const BY_FORMAT: Readonly<Record<SchemaFormat, string>> = {
  uuid: SAMPLE_UUID,
  email: 'sample@example.test',
  uri: 'https://example.test/sample',
  'date-time': '2020-01-01T00:00:00.000Z',
  slug: SAMPLE_STRING,
  timezone: 'UTC',
  locale: 'en',
  cursor: SAMPLE_STRING,
};

/**
 * The value a formatted string node gets, or `undefined` for an unformatted one.
 * `Object.hasOwn`, never the read alone: `node.format` comes from a provider's IR, and
 * `BY_FORMAT['constructor']` is the `Object` function off the prototype chain.
 */
export function formatValue(node: SchemaNode): string | undefined {
  if (node.format === undefined) return undefined;
  return Object.hasOwn(BY_FORMAT, node.format) ? BY_FORMAT[node.format] : SAMPLE_STRING;
}

/**
 * The most items a sample will hold. `minItems` past this is an input the framework does not
 * invent — `2 ** 32` made `Array.from` throw. Such an array is a GAP (`sampleGaps`), reported as
 * `X_CONTRACT_DRIFT` with the instruction to pass the input, never silently under-sampled.
 */
export const SAMPLE_ITEMS_MAX = 1000;

/**
 * The `minItems` an array sample owes, or `undefined` when none can be built: past the ceiling,
 * or not a count at all. The builtin `t.array` refuses a bad bound at declaration, but this IR
 * may come from a swapped provider.
 */
export function owedItems(node: SchemaNode): number | undefined {
  const min = node.minItems;
  if (min === undefined) return 0;
  return Number.isSafeInteger(min) && min >= 0 && min <= SAMPLE_ITEMS_MAX ? min : undefined;
}

/** `'sample'`, padded to `minLength` and cut to `maxLength`. */
function paddedSample(node: SchemaNode): string {
  const min = node.minLength ?? 0;
  const padded = SAMPLE_STRING.length >= min ? SAMPLE_STRING : SAMPLE_STRING.padEnd(min, 'x');
  return node.maxLength === undefined ? padded : padded.slice(0, node.maxLength);
}

/** The seed the minimal draw walks a pattern with: fixed, so the minimal sample never varies. */
const MINIMAL_PATTERN_SEED = 1;

/** How many candidates a pattern draw offers before the length bounds pick among them. */
const PATTERN_CANDIDATES = 8;

/**
 * A string the node's `pattern` accepts, built from the pattern itself (`sample-pattern.ts`) and
 * inside `minLength`/`maxLength`; `undefined` when the pattern is past the generator's subset,
 * uncompilable, or meets no length bound — which `sampleGaps` then reports, never a guess.
 */
export function patternString(node: SchemaNode, seed: number): string | undefined {
  if (node.pattern === undefined) return undefined;
  let pattern: RegExp;
  try {
    pattern = new RegExp(node.pattern, node.patternFlags ?? '');
  } catch {
    return undefined;
  }
  const fits = (value: string): boolean =>
    charCount(value) >= (node.minLength ?? 0) &&
    (node.maxLength === undefined || charCount(value) <= node.maxLength);
  return patternSamples(pattern, seed, PATTERN_CANDIDATES).find(fits);
}

/**
 * `'sample'`, padded to `minLength` and cut to `maxLength` — or, when the node's `pattern` refuses
 * that, the first value the pattern itself yields. A pattern `'sample'` meets keeps `'sample'`.
 */
export function minimalString(node: SchemaNode): string {
  const padded = paddedSample(node);
  if (satisfiesPattern(node, padded)) return padded;
  return patternString(node, MINIMAL_PATTERN_SEED) ?? padded;
}

/** The lower bound, rounded inward for an integer, or the upper one when the lower overshoots. */
export function minimalNumber(node: SchemaNode): number {
  const low = node.minimum ?? 0;
  const value = node.integer === true ? Math.ceil(low) : low;
  if (node.maximum === undefined || value <= node.maximum) return value;
  return node.integer === true ? Math.floor(node.maximum) : node.maximum;
}

/**
 * Whether `value` satisfies the node's own `pattern`. An uncompilable pattern is a gap, not a
 * throw: only a foreign provider's IR can produce one, and a generated contract test must not die
 * on the way to reporting what it needs.
 */
export function satisfiesPattern(node: SchemaNode, value: unknown): boolean {
  if (node.pattern === undefined) return true;
  if (typeof value !== 'string') return false;
  try {
    return new RegExp(node.pattern, node.patternFlags ?? '').test(value);
  } catch {
    return false;
  }
}

/**
 * The smallest value each choice allows: `null` where nullable, no optional key, the fewest
 * items, the first member. The policy assertion's sample, byte for byte what it always was.
 */
export const minimalDraw: Draw = Object.freeze({
  string: minimalString,
  number: minimalNumber,
  boolean: () => false,
  include: () => false,
  items: (node: SchemaNode) => owedItems(node) ?? 0,
  member: <T>(choices: readonly T[]): T | undefined => choices[0],
  nullable: () => true,
});
