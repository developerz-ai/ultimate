// `redisClient()` rides `@ultimat3/core/redis` and never the barrel: core is in every bundle graph,
// and this module reads `Bun.RedisClient`, which a page must not pay for (axiom 6).

import { describe, expect, test } from 'bun:test';
import corePackage from '../package.json';
import * as barrel from './index';
import * as subpath from './redis-client';

describe('unit · @ultimat3/core/redis', () => {
  test('the barrel exports no redis name; the subpath exports the client and its options', () => {
    const names = Object.keys(barrel);
    for (const name of ['redisClient', 'redisUrl', 'REDIS_CLIENT_OPTIONS']) {
      expect(names).not.toContain(name);
    }
    expect(typeof subpath.redisClient).toBe('function');
    expect(typeof subpath.redisUrl).toBe('function');
  });

  test('the package exports the subpath at that one file', () => {
    expect(corePackage.exports['./redis']).toBe('./src/redis-client.ts');
  });
});
