/**
 * The read path: a per-request memo (`readOnce` — same query twice in one render costs one
 * execution, whether the second read follows the first or races it) and, for a query that
 * declares `cache:`, the fill through the tier `read-cache.ts` owns (`readThrough`). Every read
 * gets the memo; the tier is the half a query opts into.
 */

import type { CacheTag } from '@ultimat3/cache';
import { bestEffort, nowMs, sampleFence } from '@ultimat3/cache';
import type { Actor, Clock, Ctx } from '@ultimat3/core';
import { assertNever } from '@ultimat3/core';
import { getReadCache } from './read-cache';
import { fingerprint } from './stable';
import { tagKeys } from './tags';

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
      return actor.orgId === undefined || actor.orgId === ''
        ? actorAuthority(actor)
        : JSON.stringify(['org', actor.orgId]);
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
 * Memo first, then the tier, then the source — what a query with `cache:` reads through.
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

/** The read itself — tier, then the source. Runs once per key per request; the rest join it. */
async function fill<T>(
  clock: Clock,
  key: string,
  ttlMs: number | null,
  tags: readonly CacheTag[],
  run: () => Promise<T>,
): Promise<T> {
  // Read per call, never captured: `setReadCache` after the first read has to be honoured, and a
  // module-level binding here would be a second handle on a tier the seam exists to swap.
  const tier = getReadCache();
  // A tier that refuses is a tier that did not answer, never a failed business read — the rule
  // `@ultimat3/cache` keeps for its own ladder, kept here through the same helper so one Redis
  // outage degrades the cache instead of 500-ing every `cache:` query. The label is `query-read`
  // and not a `TierName`: this seam is not a rung of that ladder, and `sortTiers` would place a
  // name it does not know ahead of the request memo.
  const cached = await bestEffort('query-read', 'get', key, () => tier.get(key));
  if (cached !== undefined) return cached.value as T;

  // Sampled BEFORE the load and asked before the write. The read below is about to answer with
  // rows it read in the past: a mutator committing in between busts a key that is not in the tier
  // yet, so the drop is a no-op reporting `errors: []`, and publishing afterwards serves the
  // pre-write rows for the whole TTL. `@ultimat3/cache`'s fence is the one mechanism for this —
  // no `cover()`, because every joiner of this key joins the same in-flight read under the same
  // scope, so there are no tags the sample missed.
  const fence = sampleFence({ key, tags });
  const value = await run();
  // The request's own clock, never `Date.now()`: every other reading of "now" on this path is
  // injected, and an expiry decided by the wall clock is one no test can drive.
  const expiresAt = ttlMs === null ? null : nowMs(clock) + ttlMs;
  // Answered either way — the rows ARE this request's answer. Only publishing is refused.
  if (fence.isValid()) {
    await bestEffort('query-read', 'set', key, () => tier.set(key, { value, expiresAt, tags }));
  }
  return value;
}
