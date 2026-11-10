// The host-wiring seam lives on `@ultimat3/db/adapter` and nowhere else: the `.` barrel is the app
// API, so a name an app never calls (the boot's default client, the PGlite loader) stays off it.

import { describe, expect, test } from 'bun:test';
import * as adapter from './adapter';
import * as barrel from './index';

const manifest: unknown = await Bun.file(new URL('../package.json', import.meta.url)).json();

describe('@ultimat3/db/adapter', () => {
  test('package.json maps ./adapter to this file', () => {
    expect(manifest).toMatchObject({ exports: { './adapter': './src/adapter.ts' } });
  });

  test('carries the default client and the PGlite loader', () => {
    expect(typeof adapter.defaultClient).toBe('function');
    expect(typeof adapter.loadPgliteDriver).toBe('function');
  });

  test('the `.` barrel carries neither, nor the internals it used to leak', () => {
    const names = Object.keys(barrel);
    for (const gone of [
      'defaultClient',
      'loadPgliteDriver',
      'migrateConcurrent',
      'rowSecurityPlan',
      'sqlStateCode',
      'counterTrigger',
    ]) {
      expect(names).not.toContain(gone);
    }
  });
});
