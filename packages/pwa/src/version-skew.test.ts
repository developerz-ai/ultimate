import { describe, expect, test } from 'bun:test';
import { BuildIdMissingError } from './errors';
import type { Deploy } from './version-skew';
import {
  buildId,
  cacheNamespace,
  detectSkew,
  retentionPlan,
  updatePolicy,
  updateSignal,
} from './version-skew';

describe('buildId', () => {
  test('is deterministic and scoped by channel so previews never collide', () => {
    const sha = 'a1b2c3d4e5f6a7b8';
    expect(buildId({ gitSha: sha })).toBe(buildId({ gitSha: sha }));
    expect(buildId({ gitSha: sha })).toBe('a1b2c3d4e5f6');
    expect(buildId({ gitSha: sha, channel: 'preview', ref: 'PR/42' })).toBe(
      'preview-pr-42-a1b2c3d4e5f6',
    );
  });

  test('refuses to invent one', () => {
    expect(() => buildId({})).toThrow(BuildIdMissingError);
  });
});

describe('detectSkew', () => {
  test('classifies the three states', () => {
    expect(detectSkew('b2', 'b2')).toBe('current');
    expect(detectSkew('b1', 'b2')).toBe('stale');
    expect(detectSkew(null, 'b2')).toBe('unknown');
    expect(detectSkew('', 'b2')).toBe('unknown');
    expect(detectSkew(undefined, 'b2')).toBe('unknown');
  });
});

describe('retentionPlan', () => {
  const deploys: readonly Deploy[] = [
    { buildId: 'b1', deployedAt: 1_000 },
    { buildId: 'b2', deployedAt: 2_000 },
    { buildId: 'b3', deployedAt: 3_000 },
    { buildId: 'b4', deployedAt: 4_000 },
    { buildId: 'b5', deployedAt: 5_000 },
  ];

  test('keeps the newest N deploys and evicts the rest', () => {
    const plan = retentionPlan(deploys, 3);
    expect(plan.retain).toEqual(['b5', 'b4', 'b3']);
    expect(plan.evict).toEqual(['b2', 'b1']);
  });

  test('names every cache that must survive activation', () => {
    const plan = retentionPlan(deploys, 2);
    expect(plan.caches).toContain(cacheNamespace('b5', 'precache'));
    expect(plan.caches).toContain(cacheNamespace('b4', 'runtime'));
    expect(plan.caches).not.toContain(cacheNamespace('b1', 'precache'));
  });

  test('never evicts everything', () => {
    expect(retentionPlan(deploys, 0).retain).toEqual(['b5']);
  });
});

describe('update policy and the AppUpdateAvailable signal', () => {
  test('a stale client is signalled, not 404ed', () => {
    const signal = updateSignal({
      clientBuildId: 'b1',
      serverBuildId: 'b2',
      policy: updatePolicy(),
      now: 1_000,
    });
    expect(signal).toEqual({
      type: 'AppUpdateAvailable',
      from: 'b1',
      to: 'b2',
      forced: false,
      deadlineAt: null,
    });
  });

  test('a current or unknown client gets no signal', () => {
    const policy = updatePolicy();
    expect(updateSignal({ clientBuildId: 'b2', serverBuildId: 'b2', policy })).toBe(null);
    expect(updateSignal({ clientBuildId: null, serverBuildId: 'b2', policy })).toBe(null);
  });

  test('a security patch forces a reload once the grace period has passed', () => {
    const policy = updatePolicy({ graceMs: 60_000, forceOn: ['security'] });
    expect(policy.shouldForce('security', 30_000)).toBe(false);
    expect(policy.shouldForce('security', 90_000)).toBe(true);
    expect(policy.shouldForce('never', 90_000)).toBe(false);

    const forced = updateSignal({
      clientBuildId: 'b1',
      serverBuildId: 'b2',
      policy,
      reason: 'security',
      staleForMs: 90_000,
      now: 5_000,
    });
    expect(forced?.forced).toBe(true);
    expect(forced?.deadlineAt).toBe(5_000);
  });
});

describe('cacheNamespace', () => {
  test('scopes every cache by build id and refuses an empty one', () => {
    expect(cacheNamespace('preview-pr-9-abc', 'runtime')).toBe('x-runtime-preview-pr-9-abc');
    expect(() => cacheNamespace('', 'runtime')).toThrow(BuildIdMissingError);
  });
});
