// Compile-time pins for the shapes this package declares but never constructs. Source, not a
// `.test.ts`, on purpose: `tsconfig.json` excludes `src/**/*.test.ts`, so `tsc -b` never reads a
// test file and a claim written there can never fail. Nothing here emits or is imported — a
// regression is a build error, the only enforcement that counts (axiom 3).

import type { Ctx } from '@ultimat3/core';
import type { HttpConfig, HttpConfigInput } from './config';
import type { RequestContext } from './context';
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
 * And carries nothing else, which the assignability pin above cannot say: an optional field added
 * to the allow branch leaves `{ allowed: true }` assignable, so the claim in that comment would
 * have gone on compiling while an allow grew somewhere to put a reason. `never` is wrapped in a
 * tuple because a bare `never` on the left of `extends` short-circuits the conditional.
 */
type AuthzAllow = Extract<AuthzDecision, { allowed: true }>;

export type _AuthzAllowCarriesNothingElse = Assert<
  [Exclude<keyof AuthzAllow, 'allowed'>] extends [never] ? true : false
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

/**
 * Every key of the RESOLVED config is settable on the input, so nothing this package tunes is
 * reachable only by editing this package.
 *
 * The whole HTTP tuning surface was unreachable from a shipped app until 12.0.0 — one fixed
 * literal in `@ultimat3/cli` was its only construction — and the half of that defect a rule can
 * see is this one: a key added to `HttpConfig` and forgotten on `HttpConfigInput` has a default
 * nobody can override, silently, forever. `scripts/config-readers.ts` cannot see it either: that
 * ratchet walks `AppConfig` and asks whether a key is READ, and this is the mirror question — can
 * a key be WRITTEN. A build error naming the key beats both.
 */
type UnsettableHttpKey = Exclude<keyof HttpConfig, keyof HttpConfigInput>;

export type _EveryHttpConfigKeyIsSettable = Assert<
  [UnsettableHttpKey] extends [never] ? true : false
>;

// There is deliberately NO second pin claiming "every settable key is app-declarable or
// boot-owned". `AppHttpConfig` is `Omit<HttpConfigInput, BootOwnedHttpKey>`, so that union is
// `keyof HttpConfigInput` by construction and the assertion is vacuously true whatever anyone
// edits — a claim that cannot fail is not a claim. The derivation IS the enforcement there; this
// file only pins what a derivation cannot say.

/**
 * `RequestContext` IS a `Ctx`, so `asCtx` stays a checked widening rather than an assertion.
 *
 * `asCtx` already carries this claim at its own call site and this pin is not a duplicate of it:
 * `asCtx` is a function body, and a future edit answering a failure there with a cast would delete
 * the enforcement and leave the comment. A pin has nothing to cast.
 *
 * The direction that matters is this one and not the reverse — `Ctx extends RequestContext` is
 * FALSE by design, because core's `Ctx` carries no `requestHeaders`, which is precisely what
 * `assertInRequest` exists to prove one way at runtime.
 */
export type _RequestContextIsACtx = Assert<RequestContext extends Ctx ? true : false>;
