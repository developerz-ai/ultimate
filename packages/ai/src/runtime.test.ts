// The ambient runtime's one structural guarantee: a scope is a separate cache INSTANCE, never a
// filter over a shared one — and the map of instances is bounded. That bound became load-bearing
// when `llm()`'s default scope stopped being the single string `'global'` and became the calling
// actor: one key per actor is one instance per actor, in a process that never restarts.

import { beforeEach, describe, expect, test } from 'bun:test';
import { memorySemanticCache } from '@ultimat3/cache';
import { MAX_CACHED_FORMATTERS } from '@ultimat3/core';
import { echoProvider } from './echo-provider';
import { hashEmbedder } from './embeddings';
import { providerGateway } from './gateway';
import {
  aiEmbedder,
  configureAi,
  installAiEmbedder,
  installAiGateway,
  installSemanticCache,
  resetAiRuntime,
  semanticCacheFor,
} from './runtime';

const built: string[] = [];

beforeEach(() => {
  resetAiRuntime();
  built.length = 0;
  installAiGateway(providerGateway({ providers: [echoProvider()] }));
  installSemanticCache((scope) => {
    built.push(scope);
    return memorySemanticCache();
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
    for (let index = 0; index < MAX_CACHED_FORMATTERS + 50; index += 1) {
      semanticCacheFor(`actor-${index}`);
    }
    // Each scope was built exactly once on its way in: the bound EVICTS, it does not refuse.
    expect(built.length).toBe(MAX_CACHED_FORMATTERS + 50);

    // FIFO, so the oldest scopes are gone and asking again rebuilds rather than answering a hit.
    semanticCacheFor('actor-0');
    expect(built.at(-1)).toBe('actor-0');

    // The most recent one is still resident, which is what makes the eviction an eviction and
    // not a cache that answers nothing.
    const before = built.length;
    semanticCacheFor(`actor-${MAX_CACHED_FORMATTERS + 49}`);
    expect(built.length).toBe(before);
  });

  test("the bound is core's, not a second one this package invented", () => {
    // Axiom 1: `cachedFormatter` is the framework's one bounded FIFO map, and its name is about
    // its first caller rather than its contract.
  });

  test('a new embedder drops every instance — vectors from two embedders are not comparable', () => {
    semanticCacheFor('org-a');
    const release = installAiEmbedder(hashEmbedder({ dimension: 8 }));
    semanticCacheFor('org-a');
    // And back: the release restores the old embedder, whose vectors the new caches never held.
    release();
    semanticCacheFor('org-a');
    expect(built).toEqual(['org-a', 'org-a', 'org-a']);
  });

  test('configureAi() starts from empty caches and keeps the installed factory', () => {
    semanticCacheFor('org-a');
    configureAi();
    semanticCacheFor('org-a');
    expect(built).toEqual(['org-a', 'org-a']);
  });
});

describe('the embedder and semanticCache ports', () => {
  test('nothing installed: the hash embedder and a memory cache per scope', () => {
    resetAiRuntime();
    expect(aiEmbedder().name).toBe('hash');
    expect(semanticCacheFor('org-a').name).toBe('memory');
  });

  test('installs stack and each release removes its own frame, in any order', () => {
    resetAiRuntime();
    const a = hashEmbedder({ dimension: 4 });
    const b = hashEmbedder({ dimension: 8 });
    const releaseA = installAiEmbedder(a);
    const releaseB = installAiEmbedder(b);
    expect(aiEmbedder()).toBe(b);
    releaseA();
    expect(aiEmbedder()).toBe(b);
    releaseB();
    expect(aiEmbedder().name).toBe('hash');
    expect(aiEmbedder().dimension).toBe(256);
  });

  test('a released cache factory builds nothing more', () => {
    resetAiRuntime();
    const scopes: string[] = [];
    const release = installSemanticCache((scope) => {
      scopes.push(scope);
      return memorySemanticCache();
    });
    semanticCacheFor('org-a');
    release();
    semanticCacheFor('org-a');
    expect(scopes).toEqual(['org-a']);
  });
});
