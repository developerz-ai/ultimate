/**
 * What a JSON object IS to this framework: the one predicate that narrows an `unknown` to a keyed
 * record. Tier 0 because `@ultimat3/action` and `@ultimat3/query` each declared an identical copy
 * in their own `stable.ts`, and the client wire path that needed it is core's now.
 */

/**
 * `typeof null === 'object'` and an array is an object, so both are excluded by hand.
 *
 * A `Date`, a `Map` and a class instance all PASS: this narrows a SHAPE, it does not certify
 * provenance. A caller that means "came out of `JSON.parse`" gets that from having called
 * `JSON.parse` itself — widening this to reject them would make it a second, quieter validator,
 * and the framework's validator is `@ultimat3/schema`.
 */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
