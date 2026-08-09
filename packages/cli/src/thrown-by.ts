// One `thrownBy` for every test in this package. What a caller acts on is the thrown *shape* —
// the code, the cause and the fix — never the class, so a test that asserts on the class would
// pass while the fix line rots. Shared rather than copied: a second copy asserts less, silently.

import { expect } from 'bun:test';

/** The three fields every `UltimateError` carries, as a test reads them off the thrown value. */
export interface ThrownShape {
  readonly code?: string;
  readonly cause?: string;
  readonly fix?: string;
}

export function thrownBy(call: () => unknown): ThrownShape {
  try {
    call();
  } catch (error) {
    return error as ThrownShape;
  }
  // Not `throw new Error(...)`: a bare throw carries no code and no fix, and this is the one
  // failure a test author most needs named. `expect.unreachable` fails through the runner, which
  // prints the assertion the caller wrote instead of a stack from inside this helper.
  return expect.unreachable('expected a throw');
}
