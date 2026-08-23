// Which cache tiers this process reads through, and the hop that tells the other replicas what it
// just dropped. The ladder is exactly what `cache.tiers` names: a rung the config lists is built or
// the boot refuses, and a rung it does not list is never built — this file used to register memo
// and lru unconditionally, redis on `REDIS_URL` and cdn on any real purge driver, so the key was
// declared, validated at boot, documented, and read by nothing.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CacheTier, PurgeDriver } from '@ultimat3/cache';
import {
  CacheDriverUnavailableError,
  createCdnTier,
  createLruTier,
  createMemoTier,
  createRedisTier,
  isNoopPurgeDriver,
  receiveInvalidationBroadcast,
  registerInvalidationBroadcast,
  registerTier,
  resetTiers,
} from '@ultimat3/cache';
import type { CacheTierName } from '@ultimat3/core';
import { CACHE_TIERS, defineConfig, logger } from '@ultimat3/core';
import type { Transport, TransportSubscription } from '@ultimat3/realtime/server';
import { APP_CONFIG_EXPORT } from './app-auth';
import { APP_CONFIG_FILE } from './app-root';
import type { Env } from './dev-services';

/**
 * The subject every replica of every app publishes tag invalidations on. One subject and not one
 * per app: a transport is already namespaced by the bus an operator pointed the deployment at,
 * and a second namespace here would be a knob whose only correct value is the default.
 */
export const CACHE_INVALIDATE_SUBJECT = 'x.cache.invalidate';

export interface CacheTiersOptions {
  readonly env: Env;
  /** Already resolved by the boot — a `cdn` rung is built against a real edge or not at all. */
  readonly purge: PurgeDriver;
  readonly transport: Transport;
  /**
   * `config.cache.tiers`, verbatim. REQUIRED, and that is the enforcement (axiom 3): a boot that
   * has not read the app's declaration cannot call this function at all — it is a type error, not
   * a convention to remember. `loadCacheTiers` is what a boot holding only a root calls for it.
   */
  readonly tiers: readonly CacheTierName[];
}

/**
 * The rungs an app that declares none gets — ASKED of `defineConfig` rather than written out, for
 * two reasons that point the same way: `defaults()` is private to `@ultimat3/core`, and a second
 * literal list of rung names is a second vocabulary that `bun run render-modes` refuses (it caught
 * exactly that here). One source, so the default cannot drift into a second ladder.
 */
export const DEFAULT_CACHE_TIERS: readonly CacheTierName[] = defineConfig({
  name: 'cache-defaults',
}).cache.tiers;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isTierList = (value: unknown): value is readonly CacheTierName[] =>
  Array.isArray(value) && value.every((entry) => CACHE_TIERS.some((name) => name === entry));

/**
 * `cache.tiers` out of the app's own `app.config.ts` — the sibling of `app-auth.ts`'s
 * `loadSignInPath`, and structural for the same reason: `defineConfig` returns a plain object, and
 * a config that resolved through an older core simply has no `cache` section.
 *
 * A list this refuses cannot come from `defineConfig` — `validate()` rejects an unknown rung one
 * `await import` above this line — so the fallback is for a hand-written config object, and the
 * two rungs every app starts from are the honest answer for one.
 */
export async function loadCacheTiers(root: string): Promise<readonly CacheTierName[]> {
  const configPath = join(root, APP_CONFIG_FILE);
  if (!existsSync(configPath)) return DEFAULT_CACHE_TIERS;
  const module = (await import(configPath)) as Record<string, unknown>;
  const config = module[APP_CONFIG_EXPORT];
  if (!isRecord(config)) return DEFAULT_CACHE_TIERS;
  const cache = config['cache'];
  if (!isRecord(cache)) return DEFAULT_CACHE_TIERS;
  const { tiers } = cache;
  return isTierList(tiers) ? tiers : DEFAULT_CACHE_TIERS;
}

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
 * precedent is `dev-assets.ts` throwing `@ultimat3/pwa`'s `PwaIconMissingError`.
 */
function buildTier(name: CacheTierName, options: CacheTiersOptions): CacheTier {
  switch (name) {
    case 'request-memo':
      return createMemoTier();
    case 'lru':
      return createLruTier();
    case 'redis':
      if (redisUrl(options.env) === undefined) {
        throw new CacheDriverUnavailableError({
          driver: 'redis',
          cause:
            'cache.tiers names it and REDIS_URL is unset, so this process would read a per-process ladder while the config declares a shared one',
          fix: 'set REDIS_URL in .env, or drop the redis tier from cache.tiers in app.config.ts',
        });
      }
      return createRedisTier();
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
      return createCdnTier({ purge: options.purge });
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

  registerInvalidationBroadcast(async (wireTags) => {
    await options.transport.publish(CACHE_INVALIDATE_SUBJECT, JSON.stringify(wireTags));
  });
  // Not awaited HERE: the boot must not block on a subscribe, and a bus that refuses one is a
  // process that misses peer invalidations, never a process that fails to start. The PROMISE is
  // held rather than a handle assigned inside a `.then`, because the release ran first whenever
  // `stop()` beat the round trip — a NATS bus plus a boot that throws in `bootRoles`, or a test
  // that boots and stops immediately — and the subscription that landed afterwards was live with
  // nobody left holding it. `mcp-host.ts`'s lazy `started` is the same shape.
  const subscribing: Promise<TransportSubscription | undefined> = options.transport
    .subscribe(CACHE_INVALIDATE_SUBJECT, (payload: string) => {
      void applyBroadcast(payload);
    })
    .catch((error: unknown) => {
      logger.warn('cache.broadcast.subscribe-failed', { error: messageOf(error) });
      return undefined;
    });

  // `resetTiers()` drops the registry AND the broadcast in one call: this boot is the only thing
  // that registers either, and a tier left behind would purge for a process that has stopped.
  return async () => {
    (await subscribing)?.unsubscribe();
    resetTiers();
  };
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : 'unknown error';

/**
 * A peer's wire tags, applied here. Never throws: a malformed frame or an undeclared tag must not
 * kill the subscriber loop, because that would silently end cross-instance invalidation for the
 * whole process — the exact failure this hop exists to prevent, arriving quietly.
 */
async function applyBroadcast(payload: string): Promise<void> {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (!Array.isArray(parsed)) return;
    const wire = parsed.filter((value): value is string => typeof value === 'string');
    if (wire.length > 0) await receiveInvalidationBroadcast(wire);
  } catch (error) {
    logger.warn('cache.broadcast.apply-failed', { error: messageOf(error) });
  }
}
