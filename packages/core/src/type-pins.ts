// Compile-time pins for the actor-facts seam. Source, not a `.test.ts`, on purpose:
// `tsconfig.json` excludes `src/**/*.test.ts`, so `tsc -b` never reads a test file and a
// type-level assertion written there can never fail. This module emits nothing and exports
// nothing anybody imports — a regression is a build error, the only enforcement that counts.

import type { Actor, ActorFactMap, FactKeysOf, FactMapOf } from './actor';

/** Fails to compile when `T` is anything but `true`. The whole mechanism. */
type Assert<T extends true> = T;

interface Viewer {
  readonly friendIds: ReadonlySet<string>;
}

/**
 * A stand-in for what an app augments `ActorFacts` with. Declared locally rather than by
 * augmenting the real interface: augmenting it HERE would declare `viewer` for every app that
 * imports the framework, and a pin that changes the product it pins is not a pin.
 */
interface SampleFacts {
  readonly viewer: Viewer;
}

type SampleMap = FactMapOf<SampleFacts>;

/** A declared fact reads back as its own type — never `unknown`, never a bag. */
type _FactIsTyped = Assert<[NonNullable<SampleMap['viewer']>] extends [Viewer] ? true : false>;

type _FactIsNotUnknown = Assert<[unknown] extends [SampleMap['viewer']] ? false : true>;

/**
 * The denial rule, as a type. Every fact is independently absent because nothing can prove one
 * was resolved — a job runner, a test and an MCP token exchange all mint actors too. A predicate
 * therefore has to branch on `undefined`, so an absent fact cannot silently read as a satisfied
 * one.
 */
type _AbsentFactIsRepresentable = Assert<undefined extends SampleMap['viewer'] ? true : false>;

/** A typo is a build error rather than a fact that is forever absent. */
type _UnknownFactIsNotAKey = Assert<'viewr' extends keyof SampleMap ? false : true>;

/** The phantom that keeps the empty interface from being `{}` is never itself a fact. */
type _PhantomIsNotAFactKey = Assert<'__ultimate' extends FactKeysOf<SampleFacts> ? false : true>;

/** An actor that resolved nothing is still an actor: every key is optional, always. */
type _NoFactsIsALegalFactMap = Assert<Record<string, never> extends SampleMap ? true : false>;

type _ActorFactMapAcceptsNothing = Assert<
  Record<string, never> extends ActorFactMap ? true : false
>;

/**
 * The seam is additive: an actor literal written before it existed still is one. `facts` is
 * optional for that reason and not only for the denial rule — a required member would have been
 * a breaking change to a tier-0 type every package depends on.
 */
type _ActorWithoutFactsIsStillAnActor = Assert<
  [
    {
      readonly kind: 'user';
      readonly id: string;
      readonly roles: readonly string[];
      readonly scopes: readonly string[];
    },
  ] extends [Actor]
    ? true
    : false
>;
