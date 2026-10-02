/**
 * e2e — client navigation on the authed app (`navigation: { client: ['app'] }` in `app.config.ts`).
 * Moving between `app/` pages swaps the server's next document into the SAME tab: no reload, the
 * socket and the page store kept, islands booted by the one hydration runtime. Everything that
 * makes the tab's state wrong for the next page is still a full load: another surface, another
 * build, another principal, an answer that is not a page. And with scripting off, the very same
 * markup is an ordinary web app.
 *
 * A marker on `window` is the verdict throughout: a soft navigation keeps it, a full load loses it.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { E2eApp, E2eTab } from '@ultimat3/testing';
import { everyCount, like, likeCount, readFlag, readNumber } from './fixtures/page-reads';
import type { AcceptanceBrowser } from './fixtures/postly';
import {
  acceptanceBrowser,
  noBrowser,
  POSTS,
  serverLikeCount,
  signInAs,
  startPostly,
} from './fixtures/postly';

/** The marker, and where the router last landed — `ultimate:navigated` fires after the swap. */
const MARK =
  'window.__postlyTab = "kept"; document.addEventListener("ultimate:navigated", () => { window.__landed = location.pathname; })';
const KEPT = 'window.__postlyTab === "kept"';
const NAV_LINK = (path: string): string => `document.querySelector('nav a[href="${path}"]')`;
/** A link the page does not render, added to `<main>` so a test can follow it like any other. */
const addLink = (id: string, href: string): string =>
  `(() => { const a = document.createElement('a'); a.id = ${JSON.stringify(id)}; a.href = ${JSON.stringify(href)}; a.textContent = 'x'; document.querySelector('main').append(a); })()`;

describe.skipIf(noBrowser)('client navigation on the app surface', () => {
  let app: E2eApp;
  let browser: AcceptanceBrowser;
  let tab: E2eTab;

  /** `/feed`, fully loaded, islands live, marked — the start of every case. */
  async function onFeed(): Promise<void> {
    await tab.goto(`${app.base}/feed`);
    await tab.waitFor('window.__xNavigation !== undefined', 'the router to start');
    await tab.waitFor(`${likeCount(POSTS.tenancy.id)} !== null`, 'the feed to render');
    await tab.evaluate(MARK);
  }

  /** A soft navigation to `path` finished: swapped, scrolled, scripts run — the same document. */
  const soft = async (path: string): Promise<void> => {
    await tab.waitFor(`window.__landed === ${JSON.stringify(path)}`, `${path} to swap in`);
    await tab.evaluate('window.__landed = undefined');
    expect(await readFlag(tab, KEPT)).toBe(true);
  };

  const full = async (what: string): Promise<void> => {
    await tab.waitFor(
      `document.readyState === 'complete' && window.__postlyTab === undefined`,
      what,
    );
  };

  beforeAll(async () => {
    app = await startPostly();
    browser = await acceptanceBrowser();
    await signInAs(browser.session, app, 'ada');
    tab = await browser.session.newTab();
  }, 240_000);

  afterAll(async () => {
    await tab?.close();
    await browser?.close();
    await app?.stop();
  });

  // The fallbacks first — each is a navigation the router must hand back to the browser.
  test('a link onto another surface (site/) is a full navigation', async () => {
    await onFeed();
    await tab.evaluate(addLink('to-site', '/pricing'));
    await tab.click('#to-site');
    await full('/pricing to load');
    expect(await tab.evaluate('location.pathname')).toBe('/pricing');
    // The marketing surface did not opt in, so it carries no router at all.
    expect(await tab.evaluate('window.__xNavigation === undefined')).toBe(true);
  }, 60_000);

  test('an answer that is not a page (a text file) is left to the browser', async () => {
    await onFeed();
    await tab.evaluate(addLink('to-robots', '/robots.txt'));
    await tab.click('#to-robots');
    await full('robots.txt to load');
    expect(await tab.evaluate('document.body.textContent')).toContain('User-agent');
  }, 60_000);

  test('a tab rendered by another build reloads instead of mixing two builds', async () => {
    await onFeed();
    await tab.evaluate(
      `document.querySelector('meta[name="x-ultimate-build"]').setAttribute('content', 'an-older-build')`,
    );
    await tab.evaluate(`${NAV_LINK('/settings')}.click()`);
    await full('a full load of /settings');
    expect(await tab.evaluate('location.pathname')).toBe('/settings');
  }, 60_000);

  test('signing out (POST, 303 onto site/, a new principal) is a full navigation', async () => {
    await onFeed();
    await tab.evaluate(
      `document.querySelector('form[method="post"] button[type="submit"]').click()`,
    );
    await full('the signed-out page');
    expect(await tab.evaluate('location.pathname')).toBe('/');
    await signInAs(browser.session, app, 'ada');
  }, 60_000);

  test('a same-surface link swaps the page in place: URL, title, focus, announcement', async () => {
    await onFeed();
    const feedTitle = await tab.evaluate('document.title');
    await tab.evaluate(`${NAV_LINK('/settings')}.click()`);
    await soft('/settings');
    expect(await tab.evaluate('document.title')).not.toBe(feedTitle);
    expect(await tab.evaluate('document.querySelectorAll("title").length')).toBe(1);
    // Keyboard and screen-reader users land on the new page, and hear its name.
    await tab.waitFor('document.activeElement === document.querySelector("main")', 'focus on main');
    await tab.waitFor(
      '[...document.querySelectorAll("[aria-live=polite]")].some((el) => el.textContent === document.title)',
      'the title announced',
    );
    // The settings island hydrated on the swapped-in body.
    await tab.waitFor(
      'document.querySelector("[data-x-island][data-x-mounted]") !== null',
      'islands',
    );
  }, 60_000);

  test('back and forward swap without a load and restore where the visitor was', async () => {
    await onFeed();
    // Added by a script, so it is the tab's and survives every swap; it makes the feed scrollable.
    await tab.evaluate(
      `(() => { const s = document.createElement('style'); s.textContent = 'main { min-height: 4000px }'; document.head.append(s); })()`,
    );
    await tab.evaluate('scrollTo(0, 900)');
    await tab.evaluate(`${NAV_LINK('/settings')}.click()`);
    await soft('/settings');
    expect(await readNumber(tab, 'scrollY')).toBe(0);
    await tab.evaluate('history.back()');
    await soft('/feed');
    await tab.waitFor(`${likeCount(POSTS.tenancy.id)} !== null`, 'the feed content back');
    await tab.waitFor('scrollY === 900', 'the scroll position restored');
    await tab.evaluate('history.forward()');
    await soft('/settings');
  }, 60_000);

  test('islands: a round trip leaves one live feed island — one click, one like', async () => {
    await onFeed();
    const before = await serverLikeCount(app, 'ada', 'tenancy');
    await tab.evaluate(`${NAV_LINK('/settings')}.click()`);
    await soft('/settings');
    await tab.evaluate(`${NAV_LINK('/feed')}.click()`);
    await soft('/feed');
    // The rows arrive after the island mounts, on a soft visit as on a full load (`onFeed`).
    await tab.waitFor(`${likeCount(POSTS.tenancy.id)} !== null`, 'the feed rows');
    await like(tab, POSTS.tenancy.id);
    await tab.waitFor(everyCount(POSTS.tenancy.id, before + 1), 'the like on screen');
    // Not two: a listener left behind by the first feed, or attached twice, would like it again.
    await Bun.sleep(1_000);
    expect(await serverLikeCount(app, 'ada', 'tenancy')).toBe(before + 1);
    expect(await readFlag(tab, everyCount(POSTS.tenancy.id, before + 1))).toBe(true);
  }, 60_000);

  test('a GET form navigates to its query in place', async () => {
    await onFeed();
    await tab.evaluate(
      `(() => { const f = document.createElement('form'); f.id = 'get-form'; f.action = '/settings'; f.innerHTML = '<input name="tab" value="profile">'; document.querySelector('main').append(f); f.requestSubmit(); })()`,
    );
    await soft('/settings');
    expect(await tab.evaluate('location.search')).toBe('?tab=profile');
  }, 60_000);

  test('a prefetch on intent answers the click — the page is fetched once', async () => {
    await onFeed();
    await tab.evaluate(
      `${NAV_LINK('/settings')}.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))`,
    );
    await Bun.sleep(500);
    await tab.evaluate(`${NAV_LINK('/settings')}.click()`);
    await soft('/settings');
    // The PAGE's own fetches, from its resource timeline — the browser-wide request log counts one
    // fetch once per hop through the app's service worker.
    expect(
      await tab.evaluate(
        `performance.getEntriesByType('resource').filter((e) => new URL(e.name).pathname === '/settings').length`,
      ),
    ).toBe(1);
  }, 60_000);

  test('navigating while a fetch is in flight cancels it — the older answer is never shown', async () => {
    await onFeed();
    await tab.evaluate(
      `(() => { ${NAV_LINK('/settings')}.click(); ${NAV_LINK('/feed')}.click(); })()`,
    );
    await Bun.sleep(1_500);
    expect(await tab.evaluate('location.pathname')).toBe('/feed');
    expect(await readFlag(tab, KEPT)).toBe(true);
    expect(await tab.evaluate('document.documentElement.hasAttribute("data-x-navigating")')).toBe(
      false,
    );
  }, 60_000);

  test('with scripting off the same links are plain navigations', async () => {
    const plain = await browser.session.newTab();
    try {
      await plain.scripting(false);
      // No `goto`: it waits on a page `load` listener, and with scripting off none runs.
      await plain.evaluate(`location.href = ${JSON.stringify(`${app.base}/feed`)}`);
      await plain.waitFor(
        'location.pathname === "/feed" && document.readyState === "complete"',
        'the feed',
      );
      expect(await plain.evaluate('window.__xNavigation === undefined')).toBe(true);
      await plain.click('nav a[href="/settings"]');
      await plain.waitFor(
        'location.pathname === "/settings" && document.readyState === "complete"',
        'the plain navigation',
      );
      expect(await plain.evaluate('document.querySelector("main") !== null')).toBe(true);
    } finally {
      await plain.scripting(true);
      await plain.close();
    }
  }, 60_000);
});
