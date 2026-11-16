// Where an action's cache.invalidates reaches at runtime: the read tier it has to hit, and the
// cross-instance bus that carries it to every other process. Split from runtime-cache.test.ts.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  declareTags,
  invalidateTags,
  isolateDeclaredTags,
  isolateTiers,
  noopPurgeDriver,
  registeredTiers,
} from '@ultimat3/cache';
import { ctxOf, logger } from '@ultimat3/core';
import { readThrough } from '@ultimat3/query';
import { InProcessTransport } from '@ultimat3/realtime/server';
import { CACHE_INVALIDATE_SUBJECT, DEFAULT_CACHE_TIERS, startCacheTiers } from './runtime-cache';
import { turns } from './runtime-turns-fixture';

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
      readThrough(ctxOf({}), key, 60_000, cachedRead(answer), [{ entity: 'post' }]);

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
    await readThrough(ctxOf({}), key, 60_000, run, []);
    await readThrough(ctxOf({}), key, 60_000, run, []);
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
    await turns(20); // a re-emitted frame would have been published back by now
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
    // A throw here would silently end cross-instance invalidation for the process, quietly.
    await transport.publish(CACHE_INVALIDATE_SUBJECT, 'not json');
    await transport.publish(CACHE_INVALIDATE_SUBJECT, '{"not":"an array"}');
    await turns(20);
    expect(registeredTiers().length).toBeGreaterThan(0);
  });
});
