// One behaviour, asserted against many subjects — RSpec's `shared_examples` / `it_behaves_like`.
// The framework's own rules are the reason it exists: "every action denies an anonymous actor" is
// a sentence about forty actions, and forty copies of it is forty places for one of them to be
// quietly missing.

import { describe } from 'bun:test';

/**
 * A named block of tests waiting for a subject. Opaque — the only thing that may run it is
 * `behavesLike`, so the `describe` nesting below is the one way these ever appear in output.
 */
export interface SharedExamples<TSubject> {
  readonly name: string;
  readonly body: (subject: () => TSubject) => void;
}

/**
 * The subject arrives as a function, not a value, for the reason `describeApp`'s accessor does:
 * the block is declared at module scope and the subject often does not exist until `beforeAll`
 * has run. Called inside each test, it is always the current one.
 */
export function sharedExamples<TSubject>(
  name: string,
  body: (subject: () => TSubject) => void,
): SharedExamples<TSubject> {
  return { name, body };
}

/**
 * Wrapped in its own `describe` so the failure line reads
 * `publishPost > behaves like an authenticated action > denies an anonymous actor` — which subject
 * failed, and which shared rule it failed. Two uses in one file therefore never collide.
 */
export function behavesLike<TSubject>(
  examples: SharedExamples<TSubject>,
  subject: () => TSubject,
): void {
  describe(`behaves like ${examples.name}`, () => {
    examples.body(subject);
  });
}
