// The tiers, and the hop between replicas. The failure case this file leads with is the one that
// shipped: `cache.tiers` was declared, validated at boot and documented, and the boot registered
// memo + lru unconditionally, redis on `REDIS_URL` and cdn on any real purge driver — so an app
// asking for one rung got four.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises'; // why: Bun has no mkdtemp and no recursive remove.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import type { PurgeDriver } from '@ultimat3/cache';
import {
  declareTags,
  invalidateTags,
  isolateDeclaredTags,
  isolateTiers,
  noopPurgeDriver,
  registeredTiers,
} from '@ultimat3/cache';
import type { UltimateError } from '@ultimat3/core';
import { createContext, isUltimateError, logger } from '@ultimat3/core';
import { readThrough } from '@ultimat3/query';
import type { Transport } from '@ultimat3/realtime/server';
import { InProcessTransport } from '@ultimat3/realtime/server';
import {
  CACHE_INVALIDATE_SUBJECT,
  DEFAULT_CACHE_TIERS,
  loadCacheTiers,
  startCacheTiers,
} from './dev-cache';

let release: (() => Promise<void>) | undefined;
let restore: (() => void) | undefined;
// `isolateDeclaredTags` and not a bare `declareTags([])`: the tag registry is process-global, and
// a file that leaves it dirty is X_TEST_REGISTRY_LEAK for whichever suite runs next.
const restoreTags = isolateDeclaredTags();

afterEach(async () => {
  await release?.();
  release = undefined;
  restore?.();
  restore = undefined;
  restoreTags();
  // Restored here and not in a describe: `bun test` runs this file in the same process as its
  // neighbours, and a patched logger left behind is their problem, not this file's.
  logger.warn = printWarning;
});

const recordingPurge = (): PurgeDriver => ({
  name: 'recording',
  async purge(keys) {
    return keys;
  },
  async purgeAll() {},
});

const REDIS_ENV = { REDIS_URL: 'redis://localhost:6379' } as const;

/** Every warn line this boot writes, captured per test — see `dev-n-plus-one.test.ts`. */
const warnings: { line: string; meta: unknown }[] = [];
let printWarning = logger.warn;

beforeEach(() => {
  printWarning = logger.warn;
  warnings.length = 0;
  logger.warn = (line: string, meta?: Record<string, unknown>): void => {
    warnings.push({ line, meta });
  };
});

/**
 * The refusal, as a value. `isUltimateError` rather than `instanceof Error`, and
 * `expect.unreachable` rather than a thrown verdict: a `fix:` is what the test is really asserting
 * on, and `message` carries only `code: title — cause`.
 */
const refusal = (start: () => unknown): UltimateError => {
  try {
    start();
  } catch (error) {
    if (isUltimateError(error)) return error;
    throw error;
  }
  return expect.unreachable('a rung this deployment cannot supply was built anyway');
};

describe('which tiers a boot registers', () => {
  /**
   * The defect, measured before the fix: this exact call registered
   * `['request-memo', 'lru', 'redis', 'cdn']` — three rungs the app never asked for, one of them
   * dialling a Redis and one of them purging a real edge. `cache.tiers` was declared, validated at
   * boot and documented, and `startCacheTiers` never looked at it.
   */
  test('an app naming a short ladder gets a short ladder', () => {
    restore = isolateTiers();
    release = startCacheTiers({
      env: REDIS_ENV,
      purge: recordingPurge(),
      transport: new InProcessTransport(),
      tiers: ['request-memo'],
    });
    expect(registeredTiers().map((tier) => tier.name)).toEqual(['request-memo']);
  });

  test('an app naming no rungs gets no cache at all', () => {
    restore = isolateTiers();
    release = startCacheTiers({
      env: REDIS_ENV,
      purge: recordingPurge(),
      transport: new InProcessTransport(),
      tiers: [],
    });
    expect(registeredTiers()).toEqual([]);
  });

  test('the two rungs that need no external state, which is what an app declares by default', () => {
    restore = isolateTiers();
    release = startCacheTiers({
      env: {},
      purge: noopPurgeDriver(),
      transport: new InProcessTransport(),
      tiers: DEFAULT_CACHE_TIERS,
    });
    expect(registeredTiers().map((tier) => tier.name)).toEqual(['request-memo', 'lru']);
  });

  // The value, not the expression: `DEFAULT_CACHE_TIERS` is `defineConfig`'s own answer, so a
  // default that moves in `@ultimat3/core` lands here as a failing test rather than as a silently
  // different ladder in every app that declares none.
  test('the default ladder is the two rungs that need no external state', () => {
    expect(DEFAULT_CACHE_TIERS).toEqual(['request-memo', 'lru']);
  });

  test('a named redis rung is built when REDIS_URL supplies it', () => {
    restore = isolateTiers();
    release = startCacheTiers({
      env: REDIS_ENV,
      purge: noopPurgeDriver(),
      transport: new InProcessTransport(),
      tiers: ['request-memo', 'lru', 'redis'],
    });
    // Registered, never dialled: `createRedisTier` resolves `Bun.redis` lazily, so selection is
    // pure here exactly as the mail and transport selections are.
    expect(registeredTiers().map((tier) => tier.name)).toContain('redis');
  });

  test('a named cdn rung is built when a credential resolved a real edge', () => {
    restore = isolateTiers();
    release = startCacheTiers({
      env: {},
      purge: recordingPurge(),
      transport: new InProcessTransport(),
      tiers: ['request-memo', 'cdn'],
    });
    expect(registeredTiers().map((tier) => tier.name)).toEqual(['request-memo', 'cdn']);
  });
});

describe('the environment supplies rungs, it never adds one', () => {
  // The config is the declaration; `REDIS_URL` is deployment detail. Reading `cache.tiers` has to
  // tell you what the ladder is, or the key is decoration again — so an env var cannot lengthen it.
  test('REDIS_URL set and redis unnamed: no shared tier, and the boot says so', () => {
    restore = isolateTiers();
    release = startCacheTiers({
      env: REDIS_ENV,
      purge: noopPurgeDriver(),
      transport: new InProcessTransport(),
      tiers: DEFAULT_CACHE_TIERS,
    });
    expect(registeredTiers().map((tier) => tier.name)).toEqual(['request-memo', 'lru']);
    expect(warnings).toEqual([
      { line: 'cache.tier.unnamed', meta: { tier: 'redis', source: 'REDIS_URL' } },
    ]);
  });

  test('a real edge and cdn unnamed: no cdn tier, and the boot says so', () => {
    restore = isolateTiers();
    release = startCacheTiers({
      env: {},
      purge: recordingPurge(),
      transport: new InProcessTransport(),
      tiers: DEFAULT_CACHE_TIERS,
    });
    expect(registeredTiers().map((tier) => tier.name)).toEqual(['request-memo', 'lru']);
    expect(warnings).toEqual([
      { line: 'cache.tier.unnamed', meta: { tier: 'cdn', source: 'recording' } },
    ]);
  });

  test('a ladder that matches its environment says nothing', () => {
    restore = isolateTiers();
    release = startCacheTiers({
      env: {},
      purge: noopPurgeDriver(),
      transport: new InProcessTransport(),
      tiers: DEFAULT_CACHE_TIERS,
    });
    expect(warnings).toEqual([]);
  });
});

describe('a named rung this deployment cannot build is a refusal, not a shorter ladder', () => {
  /**
   * `assertRateLimitScope`'s rule, applied to the ladder: a process that cannot build what it was
   * configured to build must not start. A fleet reading per-process caches under a config that
   * declares a shared one is the failure that looks like a performance problem for a week.
   */
  test('cache.tiers names redis and REDIS_URL is unset', () => {
    restore = isolateTiers();
    const error = refusal(() =>
      startCacheTiers({
        env: {},
        purge: noopPurgeDriver(),
        transport: new InProcessTransport(),
        tiers: ['request-memo', 'lru', 'redis'],
      }),
    );
    expect(error.code).toBe('X_CACHE_DRIVER_UNAVAILABLE');
    expect(error.fix).toBe(
      'set REDIS_URL in .env, or drop the redis tier from cache.tiers in app.config.ts',
    );
  });

  // The refusal happens before ANY rung is registered, or the two that came first would be left in
  // the process-global registry with no release returned to drop them.
  test('the refusal leaves nothing registered', () => {
    restore = isolateTiers();
    refusal(() =>
      startCacheTiers({
        env: {},
        purge: noopPurgeDriver(),
        transport: new InProcessTransport(),
        tiers: ['request-memo', 'lru', 'redis'],
      }),
    );
    expect(registeredTiers()).toEqual([]);
  });

  test('cache.tiers names cdn and no credential resolved an edge', () => {
    restore = isolateTiers();
    const error = refusal(() =>
      startCacheTiers({
        env: {},
        purge: noopPurgeDriver(),
        transport: new InProcessTransport(),
        tiers: ['request-memo', 'cdn'],
      }),
    );
    expect(error.code).toBe('X_CACHE_DRIVER_UNAVAILABLE');
    expect(error.fix).toContain('drop the cdn tier from cache.tiers in app.config.ts');
    expect(registeredTiers()).toEqual([]);
  });
});

describe("where the ladder comes from: the app's own cache.tiers", () => {
  let root = '';

  beforeEach(async () => {
    // A fresh path per test: `import()` caches by resolved specifier for the life of the process,
    // so two configs written to the same filename would hand the second test the first's exports.
    root = await mkdtemp(join(tmpdir(), 'ultimate-dev-cache-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const writeConfig = (body: string): Promise<number> =>
    Bun.write(join(root, 'app.config.ts'), body);

  test('the rungs the app declared, verbatim', async () => {
    await writeConfig(
      "export const config = { name: 'demo', cache: { tiers: ['request-memo', 'redis'] } };\n",
    );
    expect(await loadCacheTiers(root)).toEqual(['request-memo', 'redis']);
  });

  test('an app that declares an empty ladder gets one', async () => {
    await writeConfig("export const config = { name: 'demo', cache: { tiers: [] } };\n");
    expect(await loadCacheTiers(root)).toEqual([]);
  });

  test('no cache section, and no app.config.ts at all, both read as the default', async () => {
    expect(await loadCacheTiers(root)).toEqual([...DEFAULT_CACHE_TIERS]);
    await writeConfig("export const config = { name: 'demo' };\n");
    expect(await loadCacheTiers(root)).toEqual([...DEFAULT_CACHE_TIERS]);
  });

  // Unreachable through `defineConfig` — `validate()` refuses an unknown rung at import — so this
  // is the hand-written config object, and a rung `sortTiers` would place at index -1 (ahead of
  // the request memo) must not reach the ladder.
  test('a rung the ladder cannot build is not taken from a hand-written config', async () => {
    await writeConfig("export const config = { name: 'demo', cache: { tiers: ['isr'] } };\n");
    expect(await loadCacheTiers(root)).toEqual([...DEFAULT_CACHE_TIERS]);
  });
});

describe('the release', () => {
  test('the release drops the whole registry, so a stopped process purges for nobody', async () => {
    restore = isolateTiers();
    const stop = startCacheTiers({
      env: {},
      purge: noopPurgeDriver(),
      transport: new InProcessTransport(),
      tiers: DEFAULT_CACHE_TIERS,
    });
    expect(registeredTiers().length).toBeGreaterThan(0);
    await stop();
    expect(registeredTiers()).toEqual([]);
  });
});

/**
 * A transport whose `subscribe` does not resolve until the test says so — the round trip a release
 * used to beat. Reachable in production with a NATS bus and a boot that throws in `bootRoles`, and
 * in any test that boots and stops immediately.
 */
function slowTransport(): {
  readonly transport: Transport;
  readonly land: () => void;
  readonly unsubscribed: () => boolean;
} {
  const inner = new InProcessTransport();
  let unsubscribed = false;
  let land = (): void => {};
  const roundTrip = new Promise<void>((resolve) => {
    land = resolve;
  });
  const transport: Transport = {
    name: 'slow',
    shared: inner.shared,
    publish: (subject, payload) => inner.publish(subject, payload),
    close: () => inner.close(),
    async subscribe(subject, handler) {
      const real = await inner.subscribe(subject, handler);
      await roundTrip;
      return {
        subject: real.subject,
        unsubscribe: () => {
          unsubscribed = true;
          real.unsubscribe();
        },
      };
    },
  };
  return { transport, land: () => land(), unsubscribed: () => unsubscribed };
}

describe('the release owns the subscription even when it beats the subscribe', () => {
  // The handle was assigned INSIDE a floating `.then`, so a release that ran first read `undefined`
  // and returned — and the subscription that landed a moment later was live on a bus with nobody
  // left holding it, for the life of the process.
  test('a release that runs before the subscribe resolves still unsubscribes', async () => {
    restore = isolateTiers();
    const bus = slowTransport();
    const stop = startCacheTiers({
      env: {},
      purge: noopPurgeDriver(),
      transport: bus.transport,
      tiers: DEFAULT_CACHE_TIERS,
    });

    const releasing = stop();
    expect(bus.unsubscribed()).toBe(false);
    // The subscribe lands AFTER the release was asked for, which is the whole race.
    bus.land();
    await releasing;

    expect(bus.unsubscribed()).toBe(true);
    expect(registeredTiers()).toEqual([]);
  });
});

describe("the read tier an action's cache.invalidates has to reach", () => {
  /**
   * The failure this pins, end to end and through the real read path. `invalidateTags` fans out to
   * REGISTERED tiers; the tier a `cache:` query filled used to be `@ultimat3/query`'s own private
   * `ReadCache`, and on a boot with no `REDIS_URL` that seam was left as a module-default
   * `MemoryReadCache` — an object in no registry. Every `cache:` read on every non-Redis
   * deployment therefore served pre-write rows for the whole TTL while the report said
   * `errors: []`. This boot installs no read tier at all now, so there is nothing to leave unwired:
   * `readThrough` fills what `startCacheTiers` registered.
   */
  const cachedRead = (answer: string): (() => Promise<string>) => {
    return async () => answer;
  };

  test('a cache: read filled by this boot is dropped by an invalidateTags fan-out', async () => {
    restore = isolateTiers();
    declareTags(['post']);
    release = startCacheTiers({
      env: {},
      purge: noopPurgeDriver(),
      transport: new InProcessTransport(),
      tiers: DEFAULT_CACHE_TIERS,
    });
    const key = 'query:feed:actor:fingerprint:post';
    const read = (answer: string): Promise<string> =>
      readThrough(createContext({}), key, 60_000, cachedRead(answer), [{ entity: 'post' }]);

    expect(await read('pre-write')).toBe('pre-write');
    // A second request: the per-request memo is a different object, so only the registered ladder
    // can be what answers with the first read's rows.
    expect(await read('post-write')).toBe('pre-write');

    await invalidateTags([{ entity: 'post' }]);

    expect(await read('post-write')).toBe('post-write');
  });

  test('the release leaves no tier behind, so a stopped process caches for nobody', async () => {
    restore = isolateTiers();
    const stop = startCacheTiers({
      env: {},
      purge: noopPurgeDriver(),
      transport: new InProcessTransport(),
      tiers: DEFAULT_CACHE_TIERS,
    });
    await stop();

    expect(registeredTiers()).toEqual([]);
    // And the read path degrades to "no cache" rather than to a private store nothing can reach.
    const key = 'query:feed:actor:after-release';
    let executed = 0;
    const run = async (): Promise<number> => {
      executed += 1;
      return executed;
    };
    await readThrough(createContext({}), key, 60_000, run, []);
    await readThrough(createContext({}), key, 60_000, run, []);
    expect(executed).toBe(2);
  });
});

describe('cross-instance invalidation', () => {
  test('a local bust is published on the wire', async () => {
    restore = isolateTiers();
    declareTags(['post']);
    const transport = new InProcessTransport();
    const seen: string[] = [];
    await transport.subscribe(CACHE_INVALIDATE_SUBJECT, (payload) => {
      seen.push(payload);
    });
    release = startCacheTiers({
      env: {},
      purge: noopPurgeDriver(),
      transport,
      tiers: DEFAULT_CACHE_TIERS,
    });

    await invalidateTags([{ entity: 'post', id: '1' }]);
    expect(seen).toHaveLength(1);
    expect(JSON.parse(seen[0] as string)).toEqual(['post:1']);
  });

  test("a peer's frame is applied here, and applying it publishes nothing back", async () => {
    restore = isolateTiers();
    declareTags(['post']);
    const transport = new InProcessTransport();
    release = startCacheTiers({
      env: {},
      purge: noopPurgeDriver(),
      transport,
      tiers: DEFAULT_CACHE_TIERS,
    });
    // Two frames arrive; if inbound re-emitted, the count would climb without bound. Re-entrancy
    // is structural — `receiveInvalidationBroadcast` is the only caller that suppresses `emit`,
    // and `emit` is not a public parameter — so this pins the property, not a flag.
    const seen: string[] = [];
    await transport.subscribe(CACHE_INVALIDATE_SUBJECT, (payload) => {
      seen.push(payload);
    });
    await transport.publish(CACHE_INVALIDATE_SUBJECT, JSON.stringify(['post:9']));
    await Bun.sleep(10);
    expect(seen).toEqual([JSON.stringify(['post:9'])]);
  });

  test('a malformed frame never kills the subscriber loop', async () => {
    restore = isolateTiers();
    const transport = new InProcessTransport();
    release = startCacheTiers({
      env: {},
      purge: noopPurgeDriver(),
      transport,
      tiers: DEFAULT_CACHE_TIERS,
    });
    // A throw here would silently end cross-instance invalidation for the whole process — the
    // exact failure the hop exists to prevent, arriving quietly.
    await transport.publish(CACHE_INVALIDATE_SUBJECT, 'not json');
    await transport.publish(CACHE_INVALIDATE_SUBJECT, '{"not":"an array"}');
    await Bun.sleep(10);
    expect(registeredTiers().length).toBeGreaterThan(0);
  });
});
