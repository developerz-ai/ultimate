// The port's two entry points: the installer reachable from `./adapter` and from nowhere else, so
// `rateLimitStore` in `apps/<app>/runtime.ts` stays the only way an app chooses a store.

import { describe, expect, test } from 'bun:test';
import * as adapter from './adapter';
import * as barrel from './index';

const manifest: unknown = await Bun.file(new URL('../package.json', import.meta.url)).json();

describe('@ultimat3/http/adapter', () => {
  test('package.json maps ./adapter to this file', () => {
    expect(manifest).toMatchObject({ exports: { './adapter': './src/adapter.ts' } });
  });

  test('carries the installer and the errors a driver throws', () => {
    expect(typeof adapter.installRateLimitStore).toBe('function');
    expect(typeof adapter.rateLimitStoreUnavailable).toBe('function');
  });

  test('the `.` barrel exports no installer and no httpServer store option path', () => {
    for (const gone of [
      'installRateLimitStore',
      'adoptRateLimitStore',
      'resetRateLimitStore',
      'withScratchRateLimitStore',
    ]) {
      expect(Object.keys(barrel)).not.toContain(gone);
    }
    expect(typeof adapter.resetRateLimitStore).toBe('function');
  });
});
