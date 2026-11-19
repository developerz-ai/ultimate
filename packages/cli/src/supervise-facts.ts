// What the supervisor can see of per-process state before any child boots: the environment,
// `apps/<app>/runtime.ts`'s stores and transport, and `app.config.ts`'s cache tiers. Loaded only
// when the CPU budget already allows more than one process (`supervise-boot.ts`).

import type { Role } from '@ultimat3/core';
import { redisUrlSource } from '@ultimat3/core/redis';
import { InProcessTransport } from '@ultimat3/realtime/server';
import { loadAppConfig } from './app-config-load';
import { cacheTiersOf } from './runtime-cache';
import type { ServeOptions } from './serve-types';
import type { SharedStateFacts, StoreScope } from './supervise-count';

const set = (value: string | undefined): boolean => value !== undefined && value.trim() !== '';

/** What the supervisor can see before any child boots: env, `runtime.ts`, `app.config.ts`. */
export async function sharedStateFacts(
  options: ServeOptions,
  role: Role,
): Promise<SharedStateFacts> {
  const runtime = options.runtime;
  const transport = runtime?.transport;
  const stores: StoreScope[] = [
    ...(runtime?.rateLimitStore === undefined
      ? []
      : [{ name: 'runtime.rateLimitStore', scope: runtime.rateLimitStore.scope }]),
    ...(runtime?.idempotencyStore === undefined
      ? []
      : [{ name: 'runtime.idempotencyStore', scope: runtime.idempotencyStore.scope }]),
  ];
  return {
    role,
    lruTier: cacheTiersOf(await loadAppConfig(options.root)).includes('lru'),
    crossingBus:
      set(options.env['NATS_URL']) ||
      (transport !== undefined && !(transport instanceof InProcessTransport)),
    redis: redisUrlSource(options.env) !== undefined,
    embeddedDatabase: !set(options.env['DATABASE_URL']),
    stores,
  };
}
