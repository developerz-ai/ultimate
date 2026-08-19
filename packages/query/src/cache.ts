/**
 * The read path: a per-request memo (`readOnce` — same query twice in one render costs one
 * execution, whether the second read follows the first or races it) and, for a query that
 * declares `cache:`, the fill through `@ultimat3/cache`'s registered tiers (`readThrough`). Every
 * read gets the memo; the ladder is the half a query opts into.
 */

import type { CacheStack, CacheTag, CacheTier } from '@ultimat3/cache';
import { createCacheStack, registeredTiers, tagKeys } from '@ultimat3/cache';
import type { Actor, Clock, Ctx } from '@ultimat3/core';
import { assertNever, fingerprint } from '@ultimat3/core';

/**
 * A `cache:` block with no `ttlMs`. Tag invalidation is the primary eviction, so this is the
 * backstop for the read whose tags never fire — one number, the same 60s `@ultimat3/cache`'s
 * LRU tier defaults to.
 */
export const DEFAULT_READ_CACHE_TTL_MS = 60_000;

/**
 * Request-scoped memo. Keyed by ctx identity so it dies with the request.
 *
 * An entry is the read *in flight*, not its value: unsettled it is the answer a caller is
 * already waiting for, settled it is the answer. That is what makes two concurrent identical
 * reads one round trip — and it is why no sentinel is needed for a legitimately `undefined`
 * value, which a value-keyed memo cannot tell apart from a miss. A promise is never `undefined`.
 */
const memos = new WeakMap<object, Map<string, Promise<unknown>>>();

export function requestMemo(ctx: Ctx): Map<string, Promise<unknown>> {
  const key: object = ctx;
  const existing = memos.get(key);
  if (existing !== undefined) return existing;
  const created = new Map<string, Promise<unknown>>();
  memos.set(key, created);
  return created;
}

/**
 * Who a cached answer may be handed back to. Declared as `cache: { scope }`.
 *
 * `actor` is the default, and the default is the mechanism (axiom 3): a read that says nothing
 * gets the NARROWEST key, which is always correct. Widening is a written statement about what the
 * rows are — `tenant` says "every member of this org gets the same rows", `global` says "everyone
 * does" — and a wrong one is visible in the declaration rather than in a support ticket.
 */
export type QueryCacheScope = 'actor' | 'tenant' | 'global';

/**
 * "This actor is inside no org", in all three spellings it arrives in. The parameter is widened
 * past core's `Actor.orgId` (`string | undefined`) on purpose: `@ultimat3/policy`'s
 * `PolicyActorFields` declares `string | null | undefined` and its `testActor` mints `orgId: null`,
 * so a `null` does reach here — and it used to miss the `undefined`/`''` test below, which handed
 * every org-less caller the single shared key `["org",null]` and served each one the rows of
 * whoever asked first. `actorAuthority` already wrote `?? null` for the same reason.
 */
const orgless = (orgId: string | null | undefined): boolean =>
  orgId === undefined || orgId === null || orgId === '';

/**
 * The authority a read was answered under, as a key component.
 *
 * `sql(input, ctx)` is handed the context, and `@ultimat3/entity` derives every tenant predicate
 * from `ctx.actor.orgId` rather than from the input — so the name, the input and the tags do not
 * identify a read's answer, and a tier keyed on those three served one org's rows to the next org
 * that asked. Folding the authority in is what `@ultimat3/entity`'s `scopeKey` does for a batched
 * point read, for exactly this reason.
 *
 * JSON, never a joined string: an actor id is app data and may carry the separator, and a value
 * that can spell a boundary can spell someone else's.
 */
export function readAuthority(actor: Actor, scope: QueryCacheScope): string {
  switch (scope) {
    case 'global':
      return '*';
    case 'tenant':
      // An actor inside no org is not a shared tenant. Nothing here can prove two org-less callers
      // see the same rows, so the key narrows to the actor rather than widening to everyone —
      // declining instead of guessing, which is the only safe direction for a sharing key.
      //
      return orgless(actor.orgId) ? actorAuthority(actor) : JSON.stringify(['org', actor.orgId]);
    case 'actor':
      return actorAuthority(actor);
    default:
      // A fourth scope is a compile error here, not a value that silently keys as `undefined`.
      return assertNever(scope);
  }
}

const actorAuthority = (actor: Actor): string =>
  JSON.stringify([actor.kind, actor.id, actor.orgId ?? null]);

/**
 * Deterministic: same query + same input + same tags + same authority => same key.
 *
 * `authority` is REQUIRED and positional rather than optional, because an optional one is one a
 * call site can forget — and a forgotten one is the cross-tenant read this argument exists to
 * make impossible. `readAuthority` is the only thing that produces it.
 */
export function cacheKeyFor(
  name: string,
  input: unknown,
  tags: readonly CacheTag[],
  authority: string,
): string {
  return `query:${name}:${authority}:${fingerprint(input)}:${tagKeys(tags).join(',')}`;
}

/**
 * One execution per key per request: the first caller runs it, every caller after joins it.
 *
 * This is the layer a query gets whether or not it declares `cache:` — an uncached read asked
 * once per row of a list is the N+1 the memo exists to collapse.
 */
export async function readOnce<T>(ctx: Ctx, key: string, run: () => Promise<T>): Promise<T> {
  const memo = requestMemo(ctx);
  const joined = memo.get(key);
  // Already answered or already being answered: the second reader waits on the first read
  // rather than starting a competing one. Awaiting a settled promise costs a microtask.
  if (joined !== undefined) return (await joined) as T;
  return publish(memo, key, run);
}

/**
 * Runs no matter what the memo holds, and then *becomes* what it holds — what `fresh: true` asks
 * for.
 *
 * Joining is the half `fresh` refuses; publishing is not. A fresh read that left the earlier entry
 * in place would read past a write for its own caller and hand the next plain read of that key in
 * the same request the answer this one just proved stale — so the guarantee would end at the one
 * call that asked for it.
 */
export function readFresh<T>(ctx: Ctx, key: string, run: () => Promise<T>): Promise<T> {
  return publish(requestMemo(ctx), key, run);
}

/** The read in flight: published before its first await, evicted if it rejects. */
async function publish<T>(
  memo: Map<string, Promise<unknown>>,
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  // Published before the first await, so a reader arriving in the same tick finds this read.
  const flight = run();
  memo.set(key, flight);
  try {
    return await flight;
  } catch (error) {
    // A rejection is not an answer. Drop it so a later read in the same request retries
    // instead of replaying one failure until the request ends. Only ours: a fresh read may have
    // replaced this entry already, and evicting that one would discard a live answer.
    if (memo.get(key) === flight) memo.delete(key);
    throw error;
  }
}

/**
 * One stack per (registry, clock) — never one per read.
 *
 * `createCacheStack` owns a single-flight map, so a stack built per call joins nothing and the
 * cross-request stampede guard would be a no-op. Keyed on the clock because the stack's expiry
 * decision and the tiers' own have to agree: a tier registered with a frozen clock under a stack
 * reading the wall clock calls every entry expired, which is the shape that made the old read
 * tier undrivable by a test.
 */
const stacks = new WeakMap<Clock, { tiers: readonly CacheTier[]; stack: CacheStack }>();

const sameTiers = (a: readonly CacheTier[], b: readonly CacheTier[]): boolean =>
  a.length === b.length && a.every((tier, index) => tier === b[index]);

function stackFor(clock: Clock): CacheStack {
  const tiers = registeredTiers();
  const held = stacks.get(clock);
  // Rebuilt whenever the registry changes — a boot that registers the shared tier after the first
  // read, and `resetTiers()` between suites. Compared element-wise by identity: a tier object is
  // registered once and never mutated, so two equal lists are the same ladder.
  if (held !== undefined && sameTiers(held.tiers, tiers)) return held.stack;
  const stack = createCacheStack(tiers, { clock });
  stacks.set(clock, { tiers, stack });
  return stack;
}

/**
 * Memo first, then the tier ladder, then the source — what a query with `cache:` reads through.
 *
 * `tags` is what the written entry is dropped by; an entry stored without them is reachable
 * only by its key and can therefore only expire.
 */
export function readThrough<T>(
  ctx: Ctx,
  key: string,
  ttlMs: number | null,
  run: () => Promise<T>,
  tags: readonly CacheTag[] = [],
): Promise<T> {
  return readOnce(ctx, key, () => fill(ctx.clock, key, ttlMs, tags, run));
}

/**
 * The read itself, through the tiers `@ultimat3/cache` has registered and no store of this
 * package's own. Runs once per key per request; the rest join it at the memo above.
 *
 * Everything this used to do by hand — the fence sampled before the load, `bestEffort` around
 * every tier call, the expiry — is `createCacheStack`'s, which is the point: there was one read
 * cache too many, and the one that lived here was in no registry, so `invalidateTags` could not
 * reach it. A relative `ttlMs` and never an absolute expiry: the tier's own clock decides when
 * the entry dies, so a tier registered with a frozen clock is drivable end to end.
 */
function fill<T>(
  clock: Clock,
  key: string,
  ttlMs: number | null,
  tags: readonly CacheTag[],
  run: () => Promise<T>,
): Promise<T> {
  // `null` is "the caller named none", never "never": every tier refuses a non-positive `ttlMs`
  // and none has an immortal entry to offer, so omitting it falls to the tier's own default.
  return stackFor(clock).read(key, run, { ...(ttlMs === null ? {} : { ttlMs }), tags });
}
