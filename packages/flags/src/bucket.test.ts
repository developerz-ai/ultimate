// A rollout is only a rollout if it is stable and roughly even. Both are asserted here rather than
// trusted: an unstable bucket flickers a user between two experiences, and a lopsided one ships a
// "10%" rollout to a third of the userbase.

import { describe, expect, test } from 'bun:test';
import { BUCKETS, bucketOf, fnv1a } from './bucket';

const actorIds = (count: number): string[] =>
  Array.from({ length: count }, (_unused, index) => `user-${index}`);

describe('unit · bucketOf', () => {
  test('gives one actor the same bucket on every call', () => {
    const first = bucketOf('search.rerank', 'user-42');
    for (let call = 0; call < 1_000; call += 1) {
      expect(bucketOf('search.rerank', 'user-42')).toBe(first);
    }
  });

  test('always lands inside 0..99', () => {
    for (const id of actorIds(2_000)) {
      const bucket = bucketOf('search.rerank', id);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(BUCKETS);
    }
  });

  test('puts one actor in different buckets for different flags', () => {
    // Not "always different" — a collision is legal. The claim is that the flag key is part of the
    // input at all, which is what stops the same cohort meeting every unfinished feature.
    const buckets = new Set(
      ['a.one', 'a.two', 'a.three', 'a.four', 'a.five'].map((key) => bucketOf(key, 'user-42')),
    );
    expect(buckets.size).toBeGreaterThan(1);
  });

  test('distributes roughly evenly across many actors', () => {
    const total = 20_000;
    const counts = new Array<number>(BUCKETS).fill(0);
    for (const id of actorIds(total)) {
      const bucket = bucketOf('search.rerank', id);
      counts[bucket] = (counts[bucket] ?? 0) + 1;
    }
    const expected = total / BUCKETS;
    // ±40% of the expected per-bucket count. Loose enough not to be a flake, tight enough that a
    // hash which collapsed onto a few buckets — the real failure — cannot pass.
    for (const count of counts) {
      expect(count).toBeGreaterThan(expected * 0.6);
      expect(count).toBeLessThan(expected * 1.4);
    }
  });

  test('a 25% rollout selects roughly a quarter of the actors', () => {
    const total = 20_000;
    const selected = actorIds(total).filter((id) => bucketOf('search.rerank', id) < 25).length;
    expect(selected / total).toBeGreaterThan(0.23);
    expect(selected / total).toBeLessThan(0.27);
  });
});

describe('unit · pinned assignments', () => {
  test('a known (flag, subject) pair keeps its bucket, so a hash change cannot re-roll everyone', () => {
    // These literals are the contract. A rollout already in production is a promise to the orgs
    // and actors inside it: changing the hash silently moves the boundary under a live rollout,
    // switching a feature off for tenants who had it. Breaking this test is the intended alarm —
    // never re-pin it to whatever the new hash says.
    expect(bucketOf('billing.export', 'org-42')).toBe(13);
    expect(bucketOf('billing.export', 'org-12')).toBe(0);
    expect(bucketOf('billing.export', 'org-1')).toBe(78);
    expect(bucketOf('billing.export', 'user-1')).toBe(51);
    expect(bucketOf('search.rerank', 'org-42')).toBe(87);
    // A record subject is the same hash — `flipper_id`-shaped ids included.
    expect(bucketOf('scraper.persist-profile', 'bank_integration:bbva')).toBe(39);
    expect(bucketOf('scraper.persist-profile', 'bank_integration:santander')).toBe(86);
  });

  test('one org gets one bucket for one flag, in this process and any other', () => {
    // Determinism is what makes "whole org in or whole org out" true across nodes and restarts:
    // the hash is pure, so a second process computing it agrees without being asked.
    const first = bucketOf('billing.export', 'org-42');
    for (let call = 0; call < 1_000; call += 1) {
      expect(bucketOf('billing.export', 'org-42')).toBe(first);
    }
  });
});

describe('unit · fnv1a', () => {
  test('is the published 32-bit FNV-1a, so two nodes agree without talking', () => {
    // Reference vectors from the FNV specification.
    expect(fnv1a('')).toBe(0x811c_9dc5);
    expect(fnv1a('a')).toBe(0xe40c_292c);
    expect(fnv1a('foobar')).toBe(0xbf9c_f968);
  });
});
