// Which cache tiers this process reads through, and the hop that tells the other replicas what it
// just dropped. `createMemoTier`, `createLruTier` and `createRedisTier` were built, exported and
// tested with ZERO callers — `dev-runtime.ts` registered the CDN tier and nothing else — so every
// cached read was recomputed on every replica on every request, and `registerInvalidationBroadcast`
// had no one to register it.

import type { CacheTier, PurgeDriver } from '@ultimat3/cache';
import {
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
import { logger } from '@ultimat3/core';
import type { Transport, TransportSubscription } from '@ultimat3/realtime';
import type { Env } from './dev-services';

/**
 * The subject every replica of every app publishes tag invalidations on. One subject and not one
 * per app: a transport is already namespaced by the bus an operator pointed the deployment at,
 * and a second namespace here would be a knob whose only correct value is the default.
 */
export const CACHE_INVALIDATE_SUBJECT = 'x.cache.invalidate';

export interface CacheTiersOptions {
  readonly env: Env;
  /** Already resolved by the boot — the CDN tier is registered only for a real edge. */
  readonly purge: PurgeDriver;
  readonly transport: Transport;
}

/**
 * The shared tier, or nothing. `REDIS_URL` is the same "an unset variable means the embedded
 * default" law the db, events, storage, mail and CDN bindings already follow — and it is the
 * variable Bun's own `Bun.redis` reads, so a tier selected here and a client built there cannot
 * point at two servers.
 */
function sharedTier(env: Env): CacheTier | undefined {
  const url = env['REDIS_URL']?.trim();
  return url === undefined || url === '' ? undefined : createRedisTier();
}

/**
 * Register the tiers, wire both halves of cross-instance invalidation, and return the release.
 *
 * The outbound half publishes the wire tags this process just dropped; the inbound half applies
 * another instance's. A message this process published is delivered back to it on every real bus
 * and is applied again — deliberately, with no node-id filter: dropping an already-dropped key is
 * idempotent and free, while a dedup table is state that can be wrong. Re-emit is impossible by
 * construction, not by a flag: `receiveInvalidationBroadcast` is the only entry point that
 * suppresses it, and `emit` is not a public parameter.
 */
export function startCacheTiers(options: CacheTiersOptions): () => Promise<void> {
  // Request-scoped memo first, then the process-local LRU: both are free of external state, so
  // they are the "embedded default" that needs no variable to switch on. Registration order does
  // not decide read order — `sortTiers` does — but it is written in read order anyway.
  registerTier(createMemoTier());
  registerTier(createLruTier());
  const shared = sharedTier(options.env);
  if (shared !== undefined) registerTier(shared);
  // Nothing installs a read tier here, and that is the point. `@ultimat3/query` used to own a
  // private `ReadCache` this boot had to hand-wire over one of the objects above, because
  // `invalidateTags` fans out to registered tiers and to nothing else — so a read cache holding
  // entries of its own was a `cache:` query an action's `invalidates` could never bust. The seam
  // is gone: a `cache:` read fills the ladder registered here, so there is one registry and one
  // fan-out and no wiring to get wrong.
  // Registered only when a credential named a real edge. A noop tier would put a `cdn` line in
  // every invalidation report claiming keys an edge that does not exist had accepted — and the
  // `/_x` cache panel renders those reports, so the lie would be the thing an agent reads.
  if (!isNoopPurgeDriver(options.purge)) {
    registerTier(createCdnTier({ purge: options.purge }));
  }

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
