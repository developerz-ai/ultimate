// What the supervisor reads of per-process state before a child boots: `app.config.ts`'s cache
// tiers, the bus and cache URLs, the database, and the stores and transport `runtime.ts` supplies.

import { afterAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { InProcessTransport } from '@ultimat3/realtime/server';
import { processRoot } from './process-root-fixture';
import type { RuntimeOverrides } from './runtime-overrides';
import { sharedStateFacts } from './supervise-facts';

const ROOT = processRoot(join(import.meta.dir, '..', '.supervise-facts-fixture'));
const BARE = join(ROOT, 'bare');
const NO_LRU = join(ROOT, 'no-lru');

afterAll(() => rm(ROOT, { recursive: true, force: true }));

describe('unit · sharedStateFacts', () => {
  test('an app with no config, no URLs and no runtime.ts: lru on the in-process bus, embedded db', async () => {
    expect(await sharedStateFacts({ root: BARE, env: {} }, 'web')).toEqual({
      role: 'web',
      lruTier: true,
      crossingBus: false,
      redis: false,
      embeddedDatabase: true,
      stores: [],
    });
  });

  test('the environment and runtime.ts say what crosses processes', async () => {
    await Bun.write(
      join(NO_LRU, 'app.config.ts'),
      "import { defineConfig } from '@ultimat3/core';\n" +
        "export const config = defineConfig({ name: 'facts', cache: { tiers: ['request-memo'] } });\n",
    );
    const runtime = {
      rateLimitStore: { scope: 'process' },
      idempotencyStore: { scope: 'shared' },
    } as unknown as RuntimeOverrides;
    const facts = await sharedStateFacts(
      {
        root: NO_LRU,
        env: { NATS_URL: 'nats://bus:4222', REDIS_URL: 'redis://cache:6379', DATABASE_URL: 'x' },
        runtime,
      },
      'sync',
    );
    expect(facts).toEqual({
      role: 'sync',
      lruTier: false,
      crossingBus: true,
      redis: true,
      embeddedDatabase: false,
      stores: [
        { name: 'runtime.rateLimitStore', scope: 'process' },
        { name: 'runtime.idempotencyStore', scope: 'shared' },
      ],
    });
  });

  test('a transport runtime.ts supplies crosses unless it is the in-process one', async () => {
    const crossing = { transport: {} } as unknown as RuntimeOverrides;
    const local = { transport: new InProcessTransport() } as unknown as RuntimeOverrides;
    expect(
      (await sharedStateFacts({ root: BARE, env: {}, runtime: crossing }, 'web')).crossingBus,
    ).toBe(true);
    expect(
      (await sharedStateFacts({ root: BARE, env: {}, runtime: local }, 'web')).crossingBus,
    ).toBe(false);
  });
});
