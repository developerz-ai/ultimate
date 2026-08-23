import { describe, expect, test } from 'bun:test';
import { BuildIdMissingError } from './errors';
import { generateServiceWorker } from './service-worker';
import type { AppUpdateAvailable, Deploy } from './version-skew';
import {
  APP_UPDATE_AVAILABLE,
  buildId,
  cacheNamespace,
  detectSkew,
  retentionPlan,
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

/**
 * The emitted worker is the ONE producer of this message, so its object literal is the message's
 * real shape. Read back out of the source rather than restated, because a second hand-written copy
 * of the field list is what let the declaration and the producer drift apart in the first place.
 */
function postedUpdateFields(): readonly string[] {
  const { source } = generateServiceWorker([], { offline: { fallback: '/offline' } }, 'b2');
  const fields = /c\.postMessage\(\{(?<fields>[^}]*)\}\)/.exec(source)?.groups?.['fields'];
  if (fields === undefined) expect.unreachable('the activate block posts no message literal');
  return fields.split(',').map((pair) => pair.slice(0, pair.indexOf(':')).trim());
}

describe('AppUpdateAvailable is the message the service worker posts, and no more', () => {
  test('every field the interface declares is on the literal the activate block emits', () => {
    // `Required<>` is the build error behind this rule: a field added to the interface — optional
    // or not — stops compiling here until the generated worker actually posts it.
    const message = { type: APP_UPDATE_AVAILABLE, to: 'b2' } satisfies Required<AppUpdateAvailable>;
    expect([...postedUpdateFields()].sort()).toEqual(Object.keys(message).sort());
  });
});

describe('cacheNamespace', () => {
  test('scopes every cache by build id and refuses an empty one', () => {
    expect(cacheNamespace('preview-pr-9-abc', 'runtime')).toBe('x-runtime-preview-pr-9-abc');
    expect(() => cacheNamespace('', 'runtime')).toThrow(BuildIdMissingError);
  });
});
