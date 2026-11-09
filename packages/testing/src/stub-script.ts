// Single responsibility: what a stubbed body ANSWERS and what it was ASKED — the scripted answers
// (`returns`, `throws`, played in order, the last repeated) and the call record. Which body is
// replaced, and how it is put back, is `stub.ts`'s; this module never touches a primitive.

import type { Actor, UltimateError } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { TestStubUnansweredError } from './stub-errors';

/** One call the stubbed body received: the PARSED input it was handed and who was asking. */
export interface StubCall<I> {
  readonly input: I;
  readonly actor: Actor;
}

/**
 * A primitive whose body answers from a script. `I` is the parsed input its body sees and `O` what
 * its body returns — the output schema still checks every answer, on every surface.
 */
export interface Stub<I, O> {
  /** The primitive's registered name. */
  readonly name: string;
  /** Every call, oldest first. `expect(stubbed).toHaveBeenCalledWith(input)` reads it. */
  readonly calls: readonly StubCall<I>[];
  /** Answer `values` in order, one per call; the last one answers every call after it. */
  returns(...values: readonly O[]): Stub<I, O>;
  /** The next call — and, if it is the last step scripted, every call after — throws `error`. */
  throws(error: UltimateError): Stub<I, O>;
}

type Step<O> =
  | { readonly kind: 'value'; readonly value: O }
  | { readonly kind: 'throw'; readonly error: UltimateError };

/** The half of a stub only this package reads: the body's replacement and the input schema. */
export interface StubWiring<I, O> {
  readonly stub: Stub<I, O>;
  /** Record the call, then play the next step. */
  answer(input: I, actor: Actor): Promise<O>;
}

const SCHEMAS = new WeakMap<object, StandardSchemaV1>();

/** The input schema a stub's expected inputs are parsed by — `toHaveBeenCalledWith`'s check. */
export function stubInputSchema(value: unknown): StandardSchemaV1 | undefined {
  return typeof value === 'object' && value !== null ? SCHEMAS.get(value) : undefined;
}

/** Build the script and record for one stubbed primitive, named `name`, parsed by `input`. */
export function stubScript<I, O>(name: string, input: StandardSchemaV1): StubWiring<I, O> {
  const calls: StubCall<I>[] = [];
  const steps: Step<O>[] = [];
  let played = 0;
  const stub: Stub<I, O> = {
    name,
    calls,
    returns(...values) {
      for (const value of values) steps.push({ kind: 'value', value });
      return stub;
    },
    throws(error) {
      steps.push({ kind: 'throw', error });
      return stub;
    },
  };
  SCHEMAS.set(stub, input);
  return {
    stub,
    answer(input, actor) {
      calls.push({ input, actor });
      const step = steps[Math.min(played, steps.length - 1)];
      played += 1;
      if (step === undefined) return Promise.reject(new TestStubUnansweredError(name));
      return step.kind === 'value' ? Promise.resolve(step.value) : Promise.reject(step.error);
    },
  };
}
