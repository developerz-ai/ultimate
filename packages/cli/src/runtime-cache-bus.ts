// Which bus carries this process's cache invalidations to the other replicas — one rule, said once
// at boot. The fanout transport when it reaches other processes (NATS, or one `runtime.ts`
// supplied); Redis pub/sub when the transport is the in-process bus and `REDIS_URL` is set (rung
// 1: roles split, Redis, no NATS); else the in-process bus, which reaches this replica only.

import type { InvalidationBus } from '@ultimat3/cache';
import { redisPubSubAt } from '@ultimat3/cache';
import { logger } from '@ultimat3/core';
import { redisUrlSource } from '@ultimat3/core/redis';
import type { Transport } from '@ultimat3/realtime/server';
import { InProcessTransport } from '@ultimat3/realtime/server';
import type { Env } from './runtime-bindings';

export interface CacheBusSelection {
  readonly bus: InvalidationBus;
  /** What the boot line says: `redis`, `nats`, `in-process`, or a supplied transport's name. */
  readonly label: string;
  /** The env key that chose Redis, or `transport` — never the URL. */
  readonly source: string;
  /** Closes a bus this selection built. The fanout transport is the boot's to close, not this. */
  release(): Promise<void>;
}

export interface SelectCacheBusInput {
  readonly env: Env;
  readonly transport: Transport;
  /** The Redis bus for a URL. Default `redisPubSubAt`; a test hands in one on its own server. */
  readonly redisPubSub?: ((url: string) => InvalidationBus) | undefined;
}

/**
 * Pure apart from the Redis bus it builds (which dials in the background). A transport that
 * already crosses processes always wins: a second hop beside NATS would deliver every bust twice
 * through two systems that can each be down on their own.
 */
export function selectCacheBus(input: SelectCacheBusInput): CacheBusSelection {
  const redis = redisUrlSource(input.env);
  if (input.transport instanceof InProcessTransport && redis !== undefined) {
    const bus = (input.redisPubSub ?? redisPubSubAt)(redis.url);
    return { bus, label: bus.name, source: redis.key, release: () => bus.close() };
  }
  return {
    bus: input.transport,
    label: input.transport.name,
    source: 'transport',
    release: async () => undefined,
  };
}

/** The boot's one line about the hop: a script may parse `bus=` (a fixed vocabulary). */
export function logCacheBus(selection: CacheBusSelection): void {
  logger.info('cache.broadcast', { bus: selection.label, source: selection.source });
}
