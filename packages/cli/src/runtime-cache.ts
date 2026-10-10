// Which cache tiers this process reads through, and the hop that tells the other replicas what it
// just dropped. The ladder is exactly what `cache.tiers` names: a rung the config lists is built or
// the boot refuses, and a rung it does not list is never built — this file used to register memo
// and lru unconditionally, redis on `REDIS_URL` and cdn on any real purge driver, so the key was
// declared, validated at boot, documented, and read by nothing.

import type { CacheTier, PurgeDriver } from '@ultimat3/cache';
import {
  CacheDriverUnavailableError,
  cdnTier,
  flushProcessTiers,
  isNoopPurgeDriver,
  lruTier,
  memoTier,
  receiveInvalidationBroadcast,
  redisTier,
  registerInvalidationBroadcast,
  registerTier,
  resetTiers,
} from '@ultimat3/cache';
import type { AppConfig, CacheTierName } from '@ultimat3/core';
import { backoffDelay, defineConfig, logger, renderThrowable } from '@ultimat3/core';
import type { Transport, TransportSubscription } from '@ultimat3/realtime/server';
import type { Env } from './runtime-bindings';

/**
 * The subject every replica of every app publishes tag invalidations on. One subject and not one
 * per app: a transport is already namespaced by the bus an operator pointed the deployment at,
 * and a second namespace here would be a knob whose only correct value is the default.
 */
export const CACHE_INVALIDATE_SUBJECT = 'x.cache.invalidate';

/**
 * "Drop everything you hold in process", on the same subject. An object, where a bust is an array
 * of wire tags: a replica from before this marker existed parses it, finds no array and ignores
 * it — its entries wait for their TTL, which is what a lost bust always cost it.
 */
export const CACHE_FLUSH_ALL = '{"flush":"all"}';

/**
 * How many refused wire tags a process keeps for the bus's return. A bound, not a queue: past it
 * the set is dropped and ONE flush-all is owed instead, so memory does not grow with the outage.
 */
export const MAX_DEFERRED_TAGS = 1_024;

export interface CacheTiersOptions {
  readonly env: Env;
  /** Already resolved by the boot — a `cdn` rung is built against a real edge or not at all. */
  readonly purge: PurgeDriver;
  readonly transport: Transport;
  /**
   * `config.cache.tiers`, verbatim. REQUIRED, and that is the enforcement (axiom 3): a boot that
   * has not read the app's declaration cannot call this function at all — it is a type error, not
   * a convention to remember. `cacheTiersOf` is what a boot holding the loaded config calls for it.
   */
  readonly tiers: readonly CacheTierName[];
  /** The wait before re-subscribing after `attempt` failures (1-based). Injected by a test. */
  readonly subscribeRetryMs?: ((attempt: number) => number) | undefined;
}

/** 1 s doubling to 30 s, full jitter: a bus that is down is retried without a fleet in lockstep. */
const defaultSubscribeRetryMs = (attempt: number): number =>
  backoffDelay({ attempt, base: 1_000, max: 30_000, jitter: 'full' });

/**
 * The rungs an app that declares none gets — ASKED of `defineConfig` rather than written out, for
 * two reasons that point the same way: `defaults()` is private to `@ultimat3/core`, and a second
 * literal list of rung names is a second vocabulary that `bun run render-modes` refuses (it caught
 * exactly that here). One source, so the default cannot drift into a second ladder.
 */
export const DEFAULT_CACHE_TIERS: readonly CacheTierName[] = defineConfig({
  name: 'cache-defaults',
}).cache.tiers;

/** `cache.tiers` out of the config `startServices` loads once; the defaults for a root with none. */
export const cacheTiersOf = (config: AppConfig | undefined): readonly CacheTierName[] =>
  config?.cache.tiers ?? DEFAULT_CACHE_TIERS;

/**
 * `REDIS_URL` is the same "an unset variable means the embedded default" law the db, events,
 * storage, mail and CDN bindings follow — and it is the variable Bun's own `Bun.redis` reads, so a
 * tier selected here and a client built there cannot point at two servers.
 */
function redisUrl(env: Env): string | undefined {
  const url = env['REDIS_URL']?.trim();
  return url === undefined || url === '' ? undefined : url;
}

/**
 * One rung, or a refusal. A process that cannot build what it was configured to build must not
 * start — `assertRateLimitScope`'s rule (`@ultimat3/http`), applied to the ladder: a fleet reading
 * a per-process cache while `cache.tiers` declares a shared one is a stale-and-slow deployment
 * that looks like a performance problem for a week.
 *
 * `X_CACHE_DRIVER_UNAVAILABLE` is BORROWED from `@ultimat3/cache` rather than twinned: "this tier
 * cannot be built here" is what that code already means, and its shipped `fix:` is this one. The
 * precedent is `runtime-assets.ts` throwing `@ultimat3/pwa`'s `PwaIconMissingError`.
 */
function buildTier(name: CacheTierName, options: CacheTiersOptions): CacheTier {
  switch (name) {
    case 'request-memo':
      return memoTier();
    case 'lru':
      return lruTier();
    case 'redis':
      if (redisUrl(options.env) === undefined) {
        throw new CacheDriverUnavailableError({
          driver: 'redis',
          cause:
            'cache.tiers names it and REDIS_URL is unset, so this process would read a per-process ladder while the config declares a shared one',
          fix: 'set REDIS_URL in .env, or drop the redis tier from cache.tiers in app.config.ts',
        });
      }
      return redisTier();
    case 'cdn':
      // A noop tier would put a `cdn` line in every invalidation report claiming keys an edge that
      // does not exist had accepted — and the `/_x` cache panel renders those reports, so the lie
      // would be the thing an agent reads.
      if (isNoopPurgeDriver(options.purge)) {
        throw new CacheDriverUnavailableError({
          driver: 'cdn',
          cause:
            'cache.tiers names it and no CDN credential is set, so every invalidation report would claim keys an edge that does not exist had accepted',
          fix: 'set FASTLY_API_TOKEN and FASTLY_SERVICE_ID in .env, or CLOUDFLARE_API_TOKEN and CLOUDFLARE_ZONE_ID, or drop the cdn tier from cache.tiers in app.config.ts',
        });
      }
      return cdnTier({ purge: options.purge });
  }
}

/**
 * The one case where the declaration and the environment disagree and the boot still proceeds: a
 * credential is set for a rung `cache.tiers` does not name. The config wins — it is the
 * declaration, an env var is deployment detail — but silently paying for a Redis or an edge
 * nothing reads is the same class of surprise the refusals above exist for, so it is said out loud.
 */
function warnUnnamed(options: CacheTiersOptions): void {
  const named = new Set(options.tiers);
  if (!named.has('redis') && redisUrl(options.env) !== undefined) {
    logger.warn('cache.tier.unnamed', { tier: 'redis', source: 'REDIS_URL' });
  }
  if (!named.has('cdn') && !isNoopPurgeDriver(options.purge)) {
    logger.warn('cache.tier.unnamed', { tier: 'cdn', source: options.purge.name });
  }
}

/**
 * Register the tiers the app declared, wire both halves of cross-instance invalidation, and return
 * the release.
 *
 * The outbound half publishes the wire tags this process just dropped; the inbound half applies
 * another instance's. A message this process published is delivered back to it on every real bus
 * and is applied again — deliberately, with no node-id filter: dropping an already-dropped key is
 * idempotent and free, while a dedup table is state that can be wrong. Re-emit is impossible by
 * construction, not by a flag: `receiveInvalidationBroadcast` is the only entry point that
 * suppresses it, and `emit` is not a public parameter.
 */
export function startCacheTiers(options: CacheTiersOptions): () => Promise<void> {
  // Built before ANY of them is registered: a refusal halfway through a list would leave the
  // process-global registry holding the rungs that came first, with no release returned to drop
  // them. Registration order does not decide read order — `sortTiers` does, by `CACHE_TIERS`.
  // Nothing installs a read tier beyond these, and that is the point: `invalidateTags` fans out to
  // registered tiers and to nothing else, so a read cache holding entries of its own was a
  // `cache:` query an action's `invalidates` could never bust.
  const built = options.tiers.map((name) => buildTier(name, options));
  for (const tier of built) registerTier(tier);
  warnUnnamed(options);

  const send = (payload: string): Promise<void> =>
    options.transport.publish(CACHE_INVALIDATE_SUBJECT, payload);
  // What the bus refused, kept for its return. A publish with no live connection is refused, not
  // buffered (`NatsTransport`), so without this a bust made during a two-second NATS restart
  // reached no peer at all. De-duplicated — a tag is a fact, not an event — and bounded.
  const deferred = new Set<string>();
  let flushOwed = false;
  const defer = (wireTags: readonly string[]): void => {
    if (flushOwed) return;
    for (const wire of wireTags) deferred.add(wire);
    if (deferred.size <= MAX_DEFERRED_TAGS) return;
    deferred.clear();
    flushOwed = true;
  };
  /** Publish what is owed. Cleared only once the bus took it; a second refusal keeps it owed. */
  const settle = async (): Promise<void> => {
    if (flushOwed) {
      await send(CACHE_FLUSH_ALL);
      flushOwed = false;
      return;
    }
    if (deferred.size === 0) return;
    const batch = [...deferred];
    await send(JSON.stringify(batch));
    for (const wire of batch) deferred.delete(wire);
  };
  const settleQuietly = (): void => {
    void settle().catch((error: unknown) => {
      logger.warn('cache.broadcast.deferred-failed', { error: broadcastErrorText(error) });
    });
  };

  registerInvalidationBroadcast(async (wireTags) => {
    try {
      await send(JSON.stringify(wireTags));
    } catch (error) {
      defer(wireTags);
      // Still thrown: the report must say the peers have not been told YET.
      throw error;
    }
    // The bus took this one, so it takes what an earlier publish could not — the case no
    // reconnect announces, a refusal with the connection up.
    if (flushOwed || deferred.size > 0) settleQuietly();
  });
  // Not awaited HERE: the boot must not block on a subscribe. The PROMISE is held rather than a
  // handle assigned inside a `.then`, because the release ran first whenever `stop()` beat the round
  // trip and the subscription that landed afterwards was live with nobody left holding it.
  // RETRIED until it lands or the release runs (s1-con #8): a refused boot subscribe used to be
  // logged once and never asked again, so the process missed every peer invalidation for its life.
  const released = Promise.withResolvers<undefined>();
  let stopped = false;
  let subscribed = false;
  /** Cuts the retry's wait short: the bus coming up is a better signal than a backoff. */
  let wake: () => void = () => undefined;
  const retryMs = options.subscribeRetryMs ?? defaultSubscribeRetryMs;
  // This process heard no peer for a window nobody measured — since boot, or since the connection
  // dropped — so nothing it holds in its own heap is known fresh. One cold cache, never a stale one.
  const flushDeaf = (source: string): void => {
    void flushProcessTiers(source);
  };
  const subscribing = (async (): Promise<TransportSubscription | undefined> => {
    for (let attempt = 1; !stopped; attempt += 1) {
      try {
        const subscription = await options.transport.subscribe(
          CACHE_INVALIDATE_SUBJECT,
          (payload: string) => {
            void applyBroadcast(payload);
          },
        );
        subscribed = true;
        if (attempt > 1) flushDeaf('cache.bus-subscribed');
        return subscription;
      } catch (error) {
        // Attempts 1, 2, 4, 8, …: the dial's own thinning (`NatsTransport`), so an outage is not
        // one line per retry per pod for as long as it lasts.
        if ((attempt & (attempt - 1)) === 0) {
          logger.warn('cache.broadcast.subscribe-failed', {
            error: broadcastErrorText(error),
            attempt,
          });
        }
        const woken = Promise.withResolvers<undefined>();
        wake = (): void => woken.resolve(undefined);
        await Promise.race([Bun.sleep(retryMs(attempt)), released.promise, woken.promise]);
      }
    }
    return undefined;
  })();
  // The bus is (back) up. The subscription came back with the connection, so from here this
  // process hears again: drop what it held while deaf, and say what it could not say.
  const offReconnect = options.transport.onReconnect(() => {
    wake();
    if (subscribed) flushDeaf('cache.bus-reconnect');
    settleQuietly();
  });

  // `resetTiers()` drops the registry AND the broadcast in one call: this boot is the only thing
  // that registers either, and a tier left behind would purge for a process that has stopped.
  return async () => {
    stopped = true;
    offReconnect();
    released.resolve(undefined);
    (await subscribing)?.unsubscribe();
    resetTiers();
  };
}

/**
 * `renderThrowable`, never `instanceof Error` + `.message`. Both run on a value this process did
 * not build — a `Proxy` traps `getPrototypeOf` and a `message` getter can raise — and a throw here
 * is inside the handler whose whole job is to keep the subscriber loop alive: losing it ends
 * cross-instance cache invalidation for the process, quietly, which is the failure the loop's own
 * `try` exists to prevent. The old form also answered `'unknown error'` for every non-`Error`
 * throw, so a driver rejecting with a string reported nothing at all.
 */
export const broadcastErrorText = (error: unknown): string => renderThrowable(error);

/** `CACHE_FLUSH_ALL`, parsed: a peer had more refused busts than it could keep. */
const isFlushAll = (parsed: unknown): boolean =>
  typeof parsed === 'object' &&
  parsed !== null &&
  !Array.isArray(parsed) &&
  Reflect.get(parsed, 'flush') === 'all';

/**
 * A peer's wire tags, applied here. Never throws: a malformed frame or an undeclared tag must not
 * kill the subscriber loop, because that would silently end cross-instance invalidation for the
 * whole process — the exact failure this hop exists to prevent, arriving quietly.
 */
async function applyBroadcast(payload: string): Promise<void> {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (isFlushAll(parsed)) {
      await flushProcessTiers('cache.broadcast');
      return;
    }
    if (!Array.isArray(parsed)) return;
    const wire = parsed.filter((value): value is string => typeof value === 'string');
    if (wire.length > 0) await receiveInvalidationBroadcast(wire);
  } catch (error) {
    logger.warn('cache.broadcast.apply-failed', { error: broadcastErrorText(error) });
  }
}
