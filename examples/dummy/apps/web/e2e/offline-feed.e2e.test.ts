/**
 * e2e — a real browser against the built output. These are the four things only a browser can
 * tell you: the streaming hole actually fills, the service worker actually installs, the offline
 * fallback actually renders, and a stale build actually offers a reload instead of a white screen.
 */

import { expect, test } from '@ultimat3/testing';

// TWO assertions here retry and SEVEN do not, and which is which is the load-bearing fact.
//
// `await expect(locator).toBeVisible()` retries to a budget; `expect(await locator.isVisible())
// .toBe(true)` takes one look. They are different assertions, not two spellings of one. The two
// retrying ones are the only two that follow an event this test does not await: the queue draining
// after `network.online()`, and the update banner appearing after `deploy.newBuild()`. Nothing in
// the page's own API says either has finished, so a single look there is a race.
//
// The other seven follow a `goto`, a `gotoStreamed` or a click whose handler paints synchronously
// — the awaited call IS the wait. A retrying assertion on those would pass even if the element
// arrived seconds late, which is the bug the test exists to catch: it would hide a race rather
// than prove there is not one. So they stay point-in-time, deliberately, and this comment is the
// reason rather than an oversight.

test('the landing page ships zero JavaScript', async ({ page, budget }) => {
  await page.goto('/');

  expect(await page.getByRole('heading', { level: 1 }).isVisible()).toBe(true);
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
  expect(await page.getByText('Tenancy is a column, not a convention').isVisible()).toBe(true);
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

  expect(
    await page.getByText('You are offline — this will be sent when you reconnect.').isVisible(),
  ).toBe(true);
  expect(await page.evaluate(() => navigator.onLine)).toBe(false);

  await network.online();
  // Retries: `network.online()` resolves when the socket is back, not when the queue has drained
  // and the server has confirmed the like. 2 seeded + 1 queued.
  await expect(page.getByText('3 likes')).toBeVisible();
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

  expect(await page.getByRole('heading', { name: 'You are offline' }).isVisible()).toBe(true);
  expect(await page.getByText('waiting to send').isVisible()).toBe(true);
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

  // Retries: `deploy.newBuild()` resolves when the new build is SERVED. The running page learns
  // about it through its service worker, which is a round trip this test cannot await.
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
  expect(await page.getByText('9 March 2026').isVisible()).toBe(true);

  await signIn(bruno);
  await page.goto('/feed');
  // Same row, same instant, Spanish locale and Madrid clock — 08:30 on the 9th.
  expect(await page.getByText('9 de marzo de 2026').isVisible()).toBe(true);
});
