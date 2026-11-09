// Single responsibility: `expect(stubbed).toHaveBeenCalledWith(input)` on a `stub()` — the expected
// input parsed by the primitive's own input schema first, so an assertion no call could ever have
// matched is a coded refusal, not a red that reads like a missing call. Every other receiver (a
// `mock()`, a `spyOn`) is handed to bun's own matcher unchanged: one name, one meaning.

import { expect } from 'bun:test';
import { renderCauseValue } from '@ultimat3/core';
import type { MatcherResult } from './matcher-result';
import { TestExpectedInputInvalidError } from './stub-errors';
import type { Stub } from './stub-script';
import { stubInputSchema } from './stub-script';

type Builtin = (this: unknown, ...expected: unknown[]) => void;

/**
 * Bun's own, captured before this module replaces it. Kept on `globalThis` under a registered
 * symbol: a second copy of this module (source and `dist/` in one process) would otherwise capture
 * the FIRST copy's replacement as "the original" and recurse.
 */
const ORIGINAL = Symbol.for('ultimate.testing.toHaveBeenCalledWith');
const slots = globalThis as unknown as Record<symbol, Builtin | undefined>;
slots[ORIGINAL] ??= (
  Object.getPrototypeOf(expect(0)) as { toHaveBeenCalledWith: Builtin }
).toHaveBeenCalledWith;
const builtin = slots[ORIGINAL] as Builtin;

interface MatcherContext {
  readonly isNot: boolean;
}

/** The expected input as the stubbed body would have received it — or a coded refusal. */
function parsed(stub: Stub<unknown, unknown>, raw: unknown): unknown {
  const schema = stubInputSchema(stub);
  if (schema === undefined) return raw;
  const result = schema['~standard'].validate(raw);
  if (result instanceof Promise) {
    throw new TestExpectedInputInvalidError('toHaveBeenCalledWith', stub.name, [
      'an async input schema cannot be checked inside a synchronous matcher',
    ]);
  }
  if (result.issues !== undefined) {
    throw new TestExpectedInputInvalidError('toHaveBeenCalledWith', stub.name, result.issues);
  }
  return result.value;
}

/** Bun's verdict on a receiver that is not a stub, as a matcher result rather than a throw. */
function delegated(context: MatcherContext, received: unknown, args: unknown[]): MatcherResult {
  try {
    builtin.apply(context.isNot ? expect(received).not : expect(received), args);
    return { pass: !context.isNot, message: () => 'bun toHaveBeenCalledWith' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { pass: context.isNot, message: () => message };
  }
}

const isStub = (value: unknown): value is Stub<unknown, unknown> =>
  stubInputSchema(value) !== undefined;

expect.extend({
  toHaveBeenCalledWith(received: unknown, ...args: unknown[]): MatcherResult {
    const context = this as unknown as MatcherContext;
    if (!isStub(received)) return delegated(context, received, args);
    const expected = parsed(received, args[0]);
    const inputs = received.calls.map((call) => call.input);
    return {
      pass: inputs.some((input) => Bun.deepEquals(input, expected)),
      message: () =>
        context.isNot
          ? `expected "${received.name}" not to have been called with ${renderCauseValue(expected)}`
          : `expected "${received.name}" to have been called with ${renderCauseValue(expected)}; its ${String(inputs.length)} call(s): ${renderCauseValue(inputs)}`,
    };
  },
});

/** Imported for its side effect by `matchers.ts`. */
export const stubMatcherInstalled = true;
