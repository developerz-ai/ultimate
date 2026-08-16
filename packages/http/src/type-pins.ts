// Compile-time pins for the shapes this package declares but never constructs. Source, not a
// `.test.ts`, on purpose: `tsconfig.json` excludes `src/**/*.test.ts`, so `tsc -b` never reads a
// test file and a type-level claim written there can never fail. This module emits nothing and
// exports nothing anybody imports — a regression is a build error, the only enforcement that
// counts (axiom 3).

import type { AuthzDecision } from './hooks';

/** Fails to compile when `T` is anything but `true`. The whole mechanism. */
type Assert<T extends true> = T;

/**
 * An allow carries nothing else. `hooks.authorize` is implemented at tier 3 by
 * `@ultimat3/action`, which never sees this package's tests — so "an allowed decision needs no
 * reason" has to be a type error at the declaration, not an assertion over a literal a test wrote.
 */
export type _AuthzAllowNeedsNothingElse = Assert<
  { allowed: true } extends AuthzDecision ? true : false
>;

/**
 * A denial must carry its reason: it is what the pipeline renders and what an agent reads.
 */
export type _AuthzDenyNeedsAReason = Assert<
  { allowed: false } extends AuthzDecision ? false : true
>;

/**
 * `code` stays optional on a denial — a limiter denying with no framework code must not have to
 * invent one, and `error-map.ts` defaults it. This is the pin that made
 * `hooks.test.ts`'s `if (!decision.allowed) expect(decision.code).toBeUndefined()` deletable: that
 * guard was statically true over a literal the test itself wrote, so it ran no production code and
 * could not fail.
 */
export type _AuthzDenyCodeIsOptional = Assert<
  { allowed: false; reason: string } extends AuthzDecision ? true : false
>;
