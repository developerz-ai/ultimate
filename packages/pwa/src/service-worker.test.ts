import { describe, expect, test } from 'bun:test';
import { CAPABILITY_SW_MARKERS } from './capabilities';
import { PwaNoOfflineFallbackError, SwScopeInvalidError } from './errors';
import type { ServiceWorkerConfig } from './service-worker';
import { generateServiceWorker } from './service-worker';
import type { PwaRoute } from './strategies';

const routes: readonly PwaRoute[] = [
  {
    path: '/',
    surface: 'site',
    mode: 'static',
    offline: 'precache',
    revision: 'aaaa1111',
    bytes: 4_096,
  },
  {
    path: '/pricing',
    surface: 'site',
    mode: 'static',
    offline: 'precache',
    revision: 'bbbb2222',
    bytes: 8_192,
  },
  {
    path: '/blog/:slug',
    surface: 'site',
    mode: 'isr',
    offline: 'runtime',
    dynamic: true,
  },
  { path: '/dashboard', surface: 'app', mode: 'stream', offline: 'runtime' },
  { path: '/reports', surface: 'app', mode: 'spa', offline: 'precache', revision: 'cccc3333' },
  { path: '/api/posts', surface: 'api', mode: 'ssr', offline: 'network-only' },
];

const config: ServiceWorkerConfig = {
  offline: { fallback: '/offline' },
  capabilities: { push: false, backgroundSync: false, badging: false },
  vapid: { publicKey: 'BKxDemo', subject: 'mailto:ops@example.test' },
};

describe('generateServiceWorker', () => {
  test('is deterministic for identical input', () => {
    const a = generateServiceWorker(routes, config, 'build-1');
    const b = generateServiceWorker(routes, config, 'build-1');
    expect(a.source).toBe(b.source);
    expect(a.source).not.toContain('Date.now()');
  });

  test('derives the runtime strategy from each route render mode', () => {
    const output = generateServiceWorker(routes, config, 'build-1');
    const byPattern = new Map(output.rules.map((rule) => [rule.pattern, rule.strategy]));

    expect(byPattern.get('^/$')).toBe('cache-first');
    expect(byPattern.get('^/blog/[^/]+/?$')).toBe('stale-while-revalidate');
    expect(byPattern.get('^/dashboard/?$')).toBe('stale-while-revalidate');
    expect(byPattern.get('^/reports/?$')).toBe('cache-first');
    // api/ renders nothing, so it gets no cache rule at all.
    expect([...byPattern.keys()].some((p) => p.includes('api'))).toBe(false);
  });

  test('caches are keyed by build id, so a preview deploy cannot poison production', () => {
    const production = generateServiceWorker(routes, config, 'abc123def456');
    const preview = generateServiceWorker(routes, config, 'preview-pr-9-abc123');

    expect(production.source).toContain('"x-precache-abc123def456"');
    expect(preview.source).toContain('"x-precache-preview-pr-9-abc123"');
    expect(preview.source).not.toContain('x-precache-abc123def456');
  });

  test('retained build ids survive activation', () => {
    const output = generateServiceWorker(
      routes,
      { ...config, retainBuildIds: ['old-1', 'old-2'] },
      'new-3',
    );
    expect(output.source).toContain('x-precache-old-1');
    expect(output.source).toContain('x-precache-old-2');
    expect(output.source).toContain('caches.delete');
  });

  test('a disabled capability emits no service-worker code for it', () => {
    const off = generateServiceWorker(routes, config, 'build-1');
    for (const marker of [...CAPABILITY_SW_MARKERS.push, ...CAPABILITY_SW_MARKERS.backgroundSync]) {
      expect(off.source).not.toContain(marker);
    }

    const on = generateServiceWorker(
      routes,
      { ...config, capabilities: { push: true, backgroundSync: true, badging: true } },
      'build-1',
    );
    for (const marker of [...CAPABILITY_SW_MARKERS.push, ...CAPABILITY_SW_MARKERS.backgroundSync]) {
      expect(on.source).toContain(marker);
    }
    expect(on.source).toContain('navigator.setAppBadge');
  });

  test('every proxied request carries the build id header', () => {
    const output = generateServiceWorker(routes, config, 'build-1');
    expect(output.source).toContain('x-ultimate-build');
    expect(output.source).toContain('h.set(BUILD_HEADER,BUILD_ID)');
  });

  test('refuses to generate without an offline fallback', () => {
    expect(() => generateServiceWorker(routes, { offline: {} }, 'build-1')).toThrow(
      PwaNoOfflineFallbackError,
    );
  });

  test('refuses a scope the service worker path cannot control', () => {
    expect(() =>
      generateServiceWorker(routes, { ...config, swPath: '/assets/sw.js', scope: '/' }, 'build-1'),
    ).toThrow(SwScopeInvalidError);
  });
});
