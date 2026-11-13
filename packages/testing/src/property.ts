// `property(gen, fn, { runs, seed })`: a claim checked against `runs` seeded draws, and a failure
// told as the smallest input that still breaks it, with the seed that replays it. No dependency
// and no ambient randomness — the preload's `Math.random` is never read — so a red run is the same
// red run on every machine. Generators: `property-gen.ts`.

import { finiteCount, renderCauseValue, UltimateError } from '@ultimat3/core';
import { DEFAULT_SEED, seededRandom } from './determinism';
import type { Gen, Shrinkable } from './property-gen';

export interface PropertyOptions {
  /** Draws to check. Default 200. */
  readonly runs?: number;
  /** Default `DEFAULT_SEED`: the gate never flakes; pass another to explore further. */
  readonly seed?: number;
  /** Shrink attempts before the smallest failure so far is reported. Default 2000. */
  readonly maxShrinks?: number;
}

/**
 * Draws grow to full size over this many runs, whatever `runs` is: the size of draw `n` never
 * depends on the total, so `{ runs: n }` replays draw `n` exactly.
 */
const SIZE_RAMP = 100;

/** What one failing call said: a throw's message, or that it answered `false`. */
type Verdict = { readonly reason: string } | undefined;

const isThenable = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && typeof Reflect.get(value, 'then') === 'function';

/** A claim that did not hold. `input` is the shrunk counterexample, for a test to assert on. */
export class PropertyFailedError extends UltimateError {
  override readonly name = 'PropertyFailedError';
  readonly input: unknown;

  constructor(init: {
    readonly seed: number;
    readonly run: number;
    readonly runs: number;
    readonly reason: string;
    readonly input: unknown;
    readonly original: unknown;
    readonly shrinkSteps: number;
  }) {
    super({
      code: 'X_TEST_PROPERTY_FAILED',
      cause: `the property failed on draw ${init.run} of ${init.runs} (seed ${init.seed}): ${init.reason}; shrunk in ${init.shrinkSteps} steps to ${renderCauseValue(init.input)} from ${renderCauseValue(init.original)}`,
      fix: `property(gen, fn, { seed: ${init.seed}, runs: ${init.run} })   # replays exactly this failure; fix the code under test, then put runs back`,
      meta: { seed: init.seed, run: init.run, shrinkSteps: init.shrinkSteps },
    });
    this.input = init.input;
  }
}

/** `fn` handed back a promise: every draw would "pass" before its assertion ran. */
export class PropertyAsyncError extends UltimateError {
  override readonly name = 'PropertyAsyncError';

  constructor() {
    super({
      code: 'X_TEST_PROPERTY_FAILED',
      cause:
        'the property returned a promise, so its assertions would run after property() had already passed every draw',
      fix: 'property(gen, (value) => { expect(decode(encode(value))).toEqual(value); })   # synchronous: await outside, draw values inside',
    });
  }
}

const verdictOf = <T>(fn: (value: T) => unknown, value: T): Verdict => {
  let answer: unknown;
  try {
    answer = fn(value);
  } catch (error) {
    return { reason: renderCauseValue(error instanceof Error ? error.message : error) };
  }
  if (isThenable(answer)) throw new PropertyAsyncError();
  return answer === false ? { reason: 'it returned false' } : undefined;
};

/** Greedy: the first smaller value that still fails is taken, and its shrinks are tried next. */
const shrink = <T>(
  failing: Shrinkable<T>,
  first: Verdict & object,
  fn: (value: T) => unknown,
  budget: number,
): { readonly tree: Shrinkable<T>; readonly verdict: Verdict & object; readonly steps: number } => {
  let tree = failing;
  let verdict = first;
  let steps = 0;
  let progressed = true;
  while (progressed && steps < budget) {
    progressed = false;
    for (const candidate of tree.shrinks()) {
      steps += 1;
      const next = verdictOf(fn, candidate.value);
      if (next !== undefined) {
        tree = candidate;
        verdict = next;
        progressed = true;
        break;
      }
      if (steps >= budget) break;
    }
  }
  return { tree, verdict, steps };
};

/**
 * Check `fn` against `runs` draws of `gen`. `fn` fails by throwing (an `expect`) or returning
 * `false`; the first failure is shrunk and thrown as `X_TEST_PROPERTY_FAILED`, naming the seed and
 * the draw that replay it.
 */
export function property<T>(
  gen: Gen<T>,
  fn: (value: T) => unknown,
  options: PropertyOptions = {},
): void {
  const runs = finiteCount('property()', 'runs', options.runs ?? 200, 1);
  const seed = finiteCount('property()', 'seed', options.seed ?? DEFAULT_SEED);
  const budget = finiteCount('property()', 'maxShrinks', options.maxShrinks ?? 2000);
  const random = seededRandom(seed);
  for (let run = 1; run <= runs; run += 1) {
    const drawn = gen.draw(random, Math.min(1, (run - 1) / SIZE_RAMP));
    const verdict = verdictOf(fn, drawn.value);
    if (verdict === undefined) continue;
    const shrunk = shrink(drawn, verdict, fn, budget);
    throw new PropertyFailedError({
      seed,
      run,
      runs,
      reason: shrunk.verdict.reason,
      input: shrunk.tree.value,
      original: drawn.value,
      shrinkSteps: shrunk.steps,
    });
  }
}
