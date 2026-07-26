import { describe, expect, test } from 'bun:test';
import { PwaNoOfflineFallbackError } from './errors';
import { offlineFallbackSource, requireOfflineFallback } from './offline-fallback';

function fixOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'fix' in error ? String(error.fix) : '';
}

describe('requireOfflineFallback', () => {
  test('you cannot ship without one, and the fix is the exact edit', () => {
    let fix = '';
    try {
      requireOfflineFallback(undefined);
    } catch (error) {
      fix = fixOf(error);
    }
    expect(fix).toBe('create app/offline.tsx and set offline.fallback');
    expect(() => requireOfflineFallback({})).toThrow(PwaNoOfflineFallbackError);
    expect(() => requireOfflineFallback({ fallback: '  ' })).toThrow(PwaNoOfflineFallbackError);
  });

  test('rejects a relative fallback path and suggests the absolute one', () => {
    let fix = '';
    try {
      requireOfflineFallback({ fallback: 'offline' });
    } catch (error) {
      fix = fixOf(error);
    }
    expect(fix).toContain("'/offline'");
  });

  test('emits a fallback handler covering navigations and images', () => {
    const fallback = requireOfflineFallback({ fallback: '/offline', image: '/offline.svg' });
    expect(fallback.document).toBe('/offline');

    const source = offlineFallbackSource(fallback);
    expect(source).toContain('"/offline"');
    expect(source).toContain("req.mode==='navigate'");
    expect(source).toContain("req.destination==='image'");
  });
});
