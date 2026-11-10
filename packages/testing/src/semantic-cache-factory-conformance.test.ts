// The semantic-cache suite over `@ultimat3/cache`'s memory driver, one per scope, and the proof it
// can fail: a factory that hands every scope the SAME cache — one tenant reading another's answer.

import { describe, expect, test } from 'bun:test';
import type { SemanticCacheFactory } from '@ultimat3/ai/adapter';
import { memorySemanticCache } from '@ultimat3/cache';
import {
  SEMANTIC_CACHE_FACTORY_CHECKS,
  semanticCacheFactoryConformance,
} from './semantic-cache-factory-conformance';
import { behavesLike } from './shared-examples';
import { testName } from './test-types';

describe(testName('unit', 'the memory semantic cache, one per scope'), () => {
  behavesLike(semanticCacheFactoryConformance, () => () => memorySemanticCache());
});

const check = (prefix: string) => {
  const found = SEMANTIC_CACHE_FACTORY_CHECKS.find((each) => each.name.startsWith(prefix));
  if (found === undefined) return expect.unreachable(`no semantic-cache check named ${prefix}`);
  return found;
};

describe(testName('unit', 'a factory that breaks the contract fails conformance'), () => {
  test('one cache shared by every scope fails the isolation check', async () => {
    const shared = memorySemanticCache();
    const sharing: SemanticCacheFactory = () => shared;
    await expect(check('two scopes are two caches').run(sharing)).rejects.toThrow();
  });

  test('every check has a name of its own', () => {
    const names = SEMANTIC_CACHE_FACTORY_CHECKS.map((each) => each.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
