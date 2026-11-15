/**
 * e2e — a route behind a flag, served: `/runs/health`'s `load` asks `runs.health`
 * (`app/runs/health/health-flag.ts`) before either read. On by default, so a member gets the page;
 * a flag that answered off, or an `isEnabled` that threw, is the error page here, never the tiles.
 * The off half — a 404 that sends no read — is `app/runs/health/page.test.ts`'s.
 */

import { expect, test } from '@ultimat3/testing';

test('a member reaches the flag-gated run health page', async ({ page, signIn, seed }) => {
  const { ada } = await seed('dev').pick({ ada: 'member:ada' });
  await signIn(ada);

  await page.goto('/runs/health');

  // One look each: the page is server-rendered with no island of its own, so the awaited `goto`
  // IS the wait. Read by `data-*`, never words a locale would change.
  expect(await page.locator('[data-stat="runs-total"]').count()).toBe(1);
  expect(await page.locator('[data-live="paused"]').count()).toBe(1);
});
