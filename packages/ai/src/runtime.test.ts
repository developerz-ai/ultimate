// The ambient runtime's one structural guarantee: a scope is a separate cache INSTANCE, never a
// filter over a shared one — and the map of instances is bounded. That bound became load-bearing
// when `llm()`'s default scope stopped being the single string `'global'` and became the calling
// actor: one key per actor is one instance per actor, in a process that never restarts.

import { beforeEach, describe, expect, test } from 'bun:test';
import { createMemorySemanticCache } from '@ultimat3/cache';
import { MAX_CACHED_FORMATTERS } from '@ultimat3/core';
import { createGateway } from './gateway';
import { EchoProvider } from './provider';
import {
  configureAi,
  MAX_SEMANTIC_CACHE_SCOPES,
  resetAiRuntime,
  semanticCacheFor,
} from './runtime';

const built: string[] = [];

beforeEach(() => {
  resetAiRuntime();
  built.length = 0;
  configureAi({
    gateway: createGateway({ providers: [new EchoProvider()] }),
    semanticCache: (scope) => {
      built.push(scope);
      return createMemorySemanticCache();
    },
  });
});

describe('semanticCacheFor', () => {
  test('one scope is one instance, and two scopes are never the same one', () => {
    const a = semanticCacheFor('org-a');
    expect(semanticCacheFor('org-a')).toBe(a);
    expect(semanticCacheFor('org-b')).not.toBe(a);
    expect(built).toEqual(['org-a', 'org-b']);
  });

  test('the instance map is bounded, so an actor-keyed default cannot grow without end', () => {
    for (let index = 0; index < MAX_SEMANTIC_CACHE_SCOPES + 50; index += 1) {
      semanticCacheFor(`actor-${index}`);
    }
    // Each scope was built exactly once on its way in: the bound EVICTS, it does not refuse.
    expect(built.length).toBe(MAX_SEMANTIC_CACHE_SCOPES + 50);

    // FIFO, so the oldest scopes are gone and asking again rebuilds rather than answering a hit.
    semanticCacheFor('actor-0');
    expect(built.at(-1)).toBe('actor-0');

    // The most recent one is still resident, which is what makes the eviction an eviction and
    // not a cache that answers nothing.
    const before = built.length;
    semanticCacheFor(`actor-${MAX_SEMANTIC_CACHE_SCOPES + 49}`);
    expect(built.length).toBe(before);
  });

  test("the bound is core's, not a second one this package invented", () => {
    // Axiom 1: `cachedFormatter` is the framework's one bounded FIFO map, and its name is about
    // its first caller rather than its contract.
    expect(MAX_SEMANTIC_CACHE_SCOPES).toBe(MAX_CACHED_FORMATTERS);
  });

  test('a new runtime drops every instance — vectors from two embedders are not comparable', () => {
    semanticCacheFor('org-a');
    configureAi({
      gateway: createGateway({ providers: [new EchoProvider()] }),
      semanticCache: (scope) => {
        built.push(scope);
        return createMemorySemanticCache();
      },
    });
    semanticCacheFor('org-a');
    expect(built).toEqual(['org-a', 'org-a']);
  });
});
