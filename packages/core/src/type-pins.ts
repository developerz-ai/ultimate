// Compile-time pins for the actor-facts seam, the config surface, the request-context patch and
// the route and cache-tier vocabularies.
// Source, not a `.test.ts`, on purpose: `tsconfig.json` excludes `src/**/*.test.ts`, so `tsc -b`
// never reads a test file and a type-level assertion written there can never fail. This module
// emits nothing and exports nothing anybody imports — a regression is a build error.

import type { Actor, ActorFactMap, FactKeysOf, FactMapOf } from './actor';
import type { CacheTierName } from './cache-vocabulary';
import type { AppConfigInput, CacheConfig, DatabaseConfig } from './config';
import type { CtxPatch } from './context';
import type { HydrateStrategy, OfflineStrategy, RenderMode } from './route-vocabulary';

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
 * The seam is additive: an actor literal carrying the required members but no `facts` still is an
 * `Actor`. `facts` is optional for that reason and not only for the denial rule — making it
 * required would be a breaking change to a tier-0 type every package depends on.
 *
 * `permissions` joined the required set in 4.0.0 and is spelled here deliberately. That WAS such a
 * breaking change, made knowingly and with a migration: policy's `PolicyActorFields` held it, so
 * `userActor({ permissions })` silently dropped it and no builder could spell a direct grant. This
 * pin is what makes the next one impossible to add by accident — a new required member fails here
 * before it fails in an app.
 */
type _ActorWithoutFactsIsStillAnActor = Assert<
  [
    {
      readonly kind: 'user';
      readonly id: string;
      readonly roles: readonly string[];
      readonly scopes: readonly string[];
      readonly permissions: readonly string[];
    },
  ] extends [Actor]
    ? true
    : false
>;

/**
 * The three `config.database` fields deleted 2026-08 must stay deleted. Each produced neither a
 * build error nor a runtime effect, which is the worst state a config field can be in: an SRE set
 * `poolSize: 3`, redeployed, and nothing changed. Re-adding one silently restores that, so the
 * pin is here rather than in a `.test.ts` — a `@ts-expect-error` in an excluded file asserts
 * nothing.
 *
 * `DATABASE_POOL_MAX` is the pool knob that works, `DATABASE_URL` is read as a literal by
 * `@ultimat3/db`'s `client.ts`, and nothing emits `SET search_path`.
 */
type DeadDatabaseField = 'urlEnv' | 'poolSize' | 'schema';

type _DatabaseConfigCarriesNoDeadField = Assert<
  Extract<keyof DatabaseConfig, DeadDatabaseField> extends never ? true : false
>;

/** And the input side with it — `Input<DatabaseConfig>` is what an `app.config.ts` writes. */
type _DatabaseInputCarriesNoDeadField = Assert<
  Extract<keyof NonNullable<AppConfigInput['database']>, DeadDatabaseField> extends never
    ? true
    : false
>;

/**
 * The two `config.cache` fields deleted 2026-08-22, held down for the reason the `database` three
 * are: `cache.tiers` is what BUILDS the ladder, so `driver: 'redis'` was a second selector that
 * selected nothing and `urlEnv` named an env key the Redis tier never reads — it reads the literal
 * `REDIS_URL`. Re-adding either restores a knob an SRE sets, redeploys, and sees no effect from.
 */
type DeadCacheField = 'driver' | 'urlEnv';

type _CacheConfigCarriesNoDeadField = Assert<
  Extract<keyof CacheConfig, DeadCacheField> extends never ? true : false
>;

/** And the input side with it — `Input<CacheConfig>` is what an `app.config.ts` writes. */
type _CacheInputCarriesNoDeadField = Assert<
  Extract<keyof NonNullable<AppConfigInput['cache']>, DeadCacheField> extends never ? true : false
>;

/**
 * Neither id a child context may patch. `withChildContext` forwards the parent's `buildId`
 * verbatim, so `{ buildId }` on the patch was an option that read as honoured and was dropped
 * without a word — the same silent-no-op class as the three `database` fields above, one tier
 * lower. `requestId` is here beside it because the two are refused for the same reason.
 */
type UnpatchableCtxKey = 'requestId' | 'buildId';

type _CtxPatchRefusesTheIds = Assert<
  Extract<keyof CtxPatch, UnpatchableCtxKey> extends never ? true : false
>;

/** And the keys a child MAY change are still there — a pin that empties the type is not a pin. */
type _CtxPatchStillPatchesTheRest = Assert<
  'actor' | 'locale' | 'tz' extends keyof CtxPatch ? true : false
>;

/**
 * Mutual assignability, not one-way. The tuples are load-bearing: a bare `A extends B` distributes
 * over a union and answers `true` for every member separately, so it cannot see a widening — which
 * is the only thing these three pins are looking for.
 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * Each route vocabulary's union must stay DERIVED from its array. `(typeof ARRAY)[number]` is what
 * makes the pair unable to disagree, and it is one careless edit from being a hand-written union
 * again — which is the shape six packages shipped until `route-vocabulary.ts` existed. Restating
 * the members here is a pin, not a copy: nothing imports these, and a member added to the array
 * without a word in the changelog is a build error rather than a silent widening five packages
 * inherit through a re-export.
 */
type _RenderModeIsItsArray = Assert<Exact<RenderMode, 'static' | 'isr' | 'ssr' | 'stream'>>;

type _OfflineStrategyIsItsArray = Assert<
  Exact<OfflineStrategy, 'precache' | 'runtime' | 'network-only'>
>;

type _HydrateStrategyIsItsArray = Assert<
  Exact<HydrateStrategy, 'idle' | 'visible' | 'interaction' | 'never'>
>;

/**
 * The cache ladder's rungs, same rule as the three above and for a defect that shipped: 8.0.0's
 * `CacheTier` was a hand-written union in `config.ts` — `memo | lru | shared | isr | cdn` — while
 * `@ultimat3/cache` ordered `request-memo | lru | redis | cdn`, so `cache: { tiers: ['isr'] }`
 * typechecked and selected nothing (issue #293). Derived from `CACHE_TIERS` now, and pinned here
 * because a `@ts-expect-error` in an excluded test file asserts nothing.
 */
type _CacheTierNameIsItsArray = Assert<
  Exact<CacheTierName, 'request-memo' | 'lru' | 'redis' | 'cdn'>
>;

/**
 * The three spellings deleted in 9.0.0 must stay deleted. `memo` and `shared` were the ladder's
 * near and shared rungs under a second name; `isr` was never a tier at all — it is a `RenderMode`,
 * and re-admitting it would put a rung `sortTiers` places at `-1` (AHEAD of the request memo)
 * back within reach of `app.config.ts`.
 */
type DeadCacheTier = 'memo' | 'shared' | 'isr';

type _CacheTiersRefuseTheOldSpellings = Assert<
  Extract<CacheTierName, DeadCacheTier> extends never ? true : false
>;

/** And `cache.tiers` is that vocabulary, not a second one — the whole of the fix. */
type _CacheConfigNamesTheLadder = Assert<Exact<CacheConfig['tiers'], readonly CacheTierName[]>>;

type _CacheInputNamesTheLadder = Assert<
  Exact<NonNullable<AppConfigInput['cache']>['tiers'], readonly CacheTierName[] | undefined>
>;
