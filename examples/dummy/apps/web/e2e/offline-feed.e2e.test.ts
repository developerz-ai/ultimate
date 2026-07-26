/**
 * e2e — a real browser against the built output. These are the four things only a browser can
 * tell you: the streaming hole actually fills, the service worker actually installs, the offline
 * fallback actually renders, and a stale build actually offers a reload instead of a white screen.
 */

import { expect, test } from '@ultimat3/testing';

test('the landing page ships zero JavaScript', async ({ page, budget }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(await budget.jsBytes('/')).toBe(0);
  expect(await page.locator('script[src]').count()).toBe(0);
});

test('the feed streams its shell before the rows resolve', async ({ page, signIn, seed }) => {
  const { ada } = await seed('dev').pick({ ada: 'member:ada' });
  await signIn(ada);

  const firstFlush = await page.gotoStreamed('/feed');

  // The header is in the first chunk; the list arrives in a later one.
  expect(firstFlush.html).toContain('Acme Editorial');
  expect(firstFlush.html).not.toContain('Tenancy is a column');
  await expect(page.getByText('Tenancy is a column, not a convention')).toBeVisible();
});

test('a like taken offline is queued, shown, and reconciled on reconnect', async ({
  page,
  signIn,
  seed,
  network,
}) => {
  const { ada } = await seed('dev').pick({ ada: 'member:ada' });
  await signIn(ada);
  await page.goto('/feed');
  await page.waitForServiceWorker();

  await network.offline();
  await page.getByRole('button', { name: 'Like' }).first().click();

  await expect(
    page.getByText('You are offline — this will be sent when you reconnect.'),
  ).toBeVisible();
  expect(await page.evaluate(() => navigator.onLine)).toBe(false);

  await network.online();
  await expect(page.getByText('3 likes')).toBeVisible(); // 2 seeded + 1 queued, server-confirmed
});

test('a cold navigation while offline lands on the fallback, not the dinosaur', async ({
  page,
  signIn,
  seed,
  network,
}) => {
  const { ada } = await seed('dev').pick({ ada: 'member:ada' });
  await signIn(ada);
  await page.goto('/feed');
  await page.waitForServiceWorker();

  await network.offline();
  await page.goto('/posts/new');

  await expect(page.getByRole('heading', { name: 'You are offline' })).toBeVisible();
  await expect(page.getByText('waiting to send')).toBeVisible();
});

test('a stale build offers a reload instead of a broken chunk', async ({
  page,
  signIn,
  seed,
  deploy,
}) => {
  const { ada } = await seed('dev').pick({ ada: 'member:ada' });
  await signIn(ada);
  await page.goto('/feed');

  await deploy.newBuild(); // same app, new immutable build id

  await expect(page.getByText('A new version is ready.')).toBeVisible();
  expect(page.url()).toContain('/feed'); // no forced navigation, no lost form state
});

test('dates render in the member’s zone, not the server’s', async ({ page, signIn, seed }) => {
  const { kenji, bruno } = await seed('dev').pick({
    kenji: 'member:kenji', // Asia/Tokyo
    bruno: 'member:bruno', // Europe/Madrid
  });

  await signIn(kenji);
  await page.goto('/feed');
  // 2026-03-09T07:30Z is 16:30 on the 9th in Tokyo.
  await expect(page.getByText('9 March 2026')).toBeVisible();

  await signIn(bruno);
  await page.goto('/feed');
  // Same row, same instant, Spanish locale and Madrid clock — 08:30 on the 9th.
  await expect(page.getByText('9 de marzo de 2026')).toBeVisible();
});
