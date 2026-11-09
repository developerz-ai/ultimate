// The two installers reachable from `@ultimat3/auth/adapter` and from nowhere else, so the boot
// (fed by `apps/<app>/runtime.ts`) stays the one place failures and spent TOTP steps are kept.

import { describe, expect, test } from 'bun:test';
import * as adapter from './adapter-subpath';
import * as barrel from './index';

const manifest: unknown = await Bun.file(new URL('../package.json', import.meta.url)).json();

describe('@ultimat3/auth/adapter', () => {
  test('package.json maps ./adapter to this file', () => {
    expect(manifest).toMatchObject({ exports: { './adapter': './src/adapter-subpath.ts' } });
  });

  const SEAMS = [
    'installAuthLimiters',
    'installTotpReplay',
    'resetAuthLimiters',
    'resetTotpReplay',
  ];

  test('carries both installers and both resets', () => {
    for (const name of SEAMS) expect(Object.keys(adapter)).toContain(name);
  });

  test('the `.` barrel carries none of them, nor the configure* names they replaced', () => {
    for (const name of [...SEAMS, 'configureAuthLimiters', 'configureTotpReplay']) {
      expect(Object.keys(barrel)).not.toContain(name);
    }
  });
});
