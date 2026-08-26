// Single responsibility: the one refusal the framework makes for a numeric option that is not a
// number. Tier 0 because twenty-one packages need it — `jobs`, `realtime` and `query` each carried
// a byte-identical copy, the shape three backoff curves and three SQL escapes already took.
// `bun run finite-bounds` is the ratchet; this is the repair it recognises.

import { assert } from './assert';

/**
 * The option, when it is a real number. Returns it so a call site stays one expression:
 * `this.#capacity = finiteOption('ChangeBuffer', 'capacity', options.capacity ?? 1024)`.
 *
 * WHY IT TAKES A FUNCTION AT ALL, since every part of the job looks already done by an operator:
 * `??` guards NULLISH and `NaN` is not nullish, so `Number(process.env.X)` on an unset variable, a
 * `parseInt` of a typo and a JSON `null`-turned-`NaN` all walk straight past the default. And
 * `Math.max` / `Math.min` / `Math.floor` PROPAGATE it rather than validating, so none of the three
 * is a screen either — `Math.min(raw, Infinity)` is `Infinity`. What the value then bounds decides
 * WHICH failure you get, and all four have shipped: a comparison that reads false forever, an
 * `Array.from({ length: NaN })` that is `[]`, a `setTimeout(fn, NaN)` that is `setTimeout(fn, 0)`,
 * and a loop that never terminates. Several packages' comments point here for this argument.
 */
export function finiteOption(subject: string, option: string, value: number): number {
  assert(
    Number.isFinite(value),
    `${subject} ${option} is ${String(value)}, so every comparison against it is false and the bound it sets does not exist`,
    `pass a finite ${option} to ${subject}, or omit it and take the default — Math.max/Math.min/Math.floor do not validate it, they propagate it`,
  );
  return value;
}

/**
 * The same rule where the option counts THINGS — rows, bytes, entries, milliseconds, slots — and a
 * fraction is as wrong as a `NaN`: `Array.from({ length: 2.5 })` throws, a `slice` truncates, and
 * above 2^53 a double cannot name its own successor, so a "count" up there is already rounded.
 * `Number.isSafeInteger`, which is what `@ultimat3/schema` demands of an integer at the wire.
 *
 * `min` is the caller's because only the caller knows what zero MEANS: `requestTimeoutMs: 0` is
 * "no deadline" and `maxInflight: 0` is "never shed", both decisions the code reads, while
 * `max: 0` connections is a pool nothing can run on. A helper that picked one would be wrong at
 * half the call sites, and this is deliberately the only knob it takes — a third function for
 * "positive" would be the copy this file exists to prevent.
 */
export function finiteCount(
  subject: string,
  option: string,
  value: number,
  min: 0 | 1 = 0,
): number {
  assert(
    Number.isSafeInteger(value) && value >= min,
    `${subject} ${option} is ${String(value)}, and it counts things: it must be a whole number of ${min === 1 ? 'at least 1' : '0 or more'}, or the bound it sets is not one`,
    `pass a whole ${option} to ${subject} — and parse an environment value before you pass it, because Number(process.env.…) is NaN when the variable is unset and Math.floor does not repair that`,
  );
  return value;
}
