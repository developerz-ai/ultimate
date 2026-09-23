// The e2e preload outside the gate: with no app root named it must be INERT. It is loaded by the
// `e2e` step's `bun test --preload`, and an import that spawned an app or a browser anywhere else —
// a stray import, a coverage run — would be a Chrome and a Postgres nobody asked for.

import { expect, test } from 'bun:test';
import { E2E_ROOT_ENV, e2eBaseUrl } from './e2e-browser-handle';

test('imported with no app root named, it spawns nothing and publishes no run', async () => {
  expect(Bun.env[E2E_ROOT_ENV] ?? '').toBe('');
  await import('./e2e-preload');

  expect(e2eBaseUrl()).toBeUndefined();
});
