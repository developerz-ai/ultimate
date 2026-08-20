// The CDP-shaped browser with no browser behind it, driven THROUGH the real target so the fake is
// never asserted against itself: every expectation below is read off `cdpTarget`, which is the
// production code path, and the fake only supplies the events and the DOM a browser would.
//
// This file exists because `mock.module('puppeteer-core')` is banned here — a mock leaks across
// concurrently-running files, and an injected value cannot.

import { describe, expect, test } from 'bun:test';
import { fakeCdpBrowser, fakeCdpLauncher } from './cdp-fake';
import { cdpTarget } from './cdp-target';
import { testClock } from './clock';
import type { InterceptRules } from './intercept';
import type { SessionSnapshot } from './session-state';

const PAGE = {
  url: 'https://shop.test/orders',
  html: '<html><body><a href="/orders/1">Order 1</a><button id="pay">Pay</button></body></html>',
};

const openOver = async (
  browser: ReturnType<typeof fakeCdpBrowser>,
  rules: InterceptRules = { allowHosts: ['shop.test'] },
) => {
  const page = await browser.newPage();
  return cdpTarget({ page, browser, rules, clock: testClock() });
};

describe('unit · the fake browser carries a real request event', () => {
  test('a refused subresource is ABORTED at the request and recorded as refused', async () => {
    const browser = fakeCdpBrowser(PAGE);
    const target = await openOver(browser);

    browser.emitRequest('https://cdn.evil.test/tracker.js', 'script');

    // Two independent observations: the target's own ring, and the abort the fake recorded —
    // the second one is what says the bytes never left, not merely that a log line was written.
    expect(target.network.entries()).toEqual([
      {
        method: 'GET',
        url: 'https://cdn.evil.test/tracker.js',
        resourceType: 'script',
        refused: 'host',
        at: 0,
      },
    ]);
    expect(browser.aborted).toEqual(['https://cdn.evil.test/tracker.js']);
  });

  test('an allowed subresource continues, and is recorded without a refusal', async () => {
    const browser = fakeCdpBrowser(PAGE);
    const target = await openOver(browser);

    browser.emitRequest('https://shop.test/api/orders.json', 'xhr');

    expect(browser.aborted).toEqual([]);
    expect(target.network.entries()[0]).toEqual({
      method: 'GET',
      url: 'https://shop.test/api/orders.json',
      resourceType: 'xhr',
      at: 0,
    });
  });

  test('a resource type the port does not know becomes "other", never the raw string', async () => {
    const browser = fakeCdpBrowser(PAGE);
    const target = await openOver(browser);
    browser.emitRequest('https://shop.test/beacon', 'ping');
    expect(target.network.entries()[0]?.resourceType).toBe('other');
  });
});

describe('unit · the fake browser`s cookie jar', () => {
  test('restore() writes through setCookie, and cookies() reads back what it wrote', async () => {
    const browser = fakeCdpBrowser(PAGE);
    const target = await openOver(browser);
    const session: SessionSnapshot = {
      cookies: [
        { name: 'sid', value: 'abc', domain: 'shop.test', path: '/', httpOnly: true, secure: true },
      ],
      headers: {},
      storage: {},
      userAgent: 'agent',
      origin: 'https://shop.test',
    };

    expect(await target.cookies()).toEqual([]);
    await target.restore(session);
    expect(await target.cookies()).toEqual(session.cookies);
  });

  test('a seeded jar is what the target reads before anything restores one', async () => {
    const browser = fakeCdpBrowser({
      ...PAGE,
      cookies: [
        { name: 'ab', value: '1', domain: 'shop.test', path: '/', httpOnly: false, secure: true },
      ],
    });
    const target = await openOver(browser);
    expect((await target.cookies()).map((cookie) => cookie.name)).toEqual(['ab']);
  });
});

describe('unit · closing', () => {
  test('closing the TARGET closes the page, which the fake reports as closed', async () => {
    const browser = fakeCdpBrowser(PAGE);
    const target = await openOver(browser);
    expect(browser.closed).toBe(false);
    await target.close();
    expect(browser.closed).toBe(true);
  });

  test('closing the BROWSER reports closed too — the driver`s rollback path', async () => {
    const browser = fakeCdpBrowser(PAGE);
    const target = await openOver(browser);
    expect(target.url()).toBe('https://shop.test/orders');
    await browser.close();
    expect(browser.closed).toBe(true);
  });
});

describe('unit · the fake page`s DOM answers the real target`s reads', () => {
  test('a route turns a click into a navigation with new content', async () => {
    const browser = fakeCdpBrowser({
      ...PAGE,
      routes: {
        '#pay': {
          url: 'https://shop.test/receipt',
          html: '<html><body><h1>Paid</h1></body></html>',
        },
      },
    });
    const target = await openOver(browser);

    await target.click('#pay', 0);

    expect(target.url()).toBe('https://shop.test/receipt');
    expect(await target.content()).toContain('Paid');
    expect((await target.query('h1')).map((element) => element.text)).toEqual(['Paid']);
  });

  test('a click with no route leaves the page where it was', async () => {
    const browser = fakeCdpBrowser(PAGE);
    const target = await openOver(browser);
    await target.click('#pay', 0);
    expect(target.url()).toBe('https://shop.test/orders');
  });

  test('every element gets a layout box, and a covered one reports hitTarget false', async () => {
    // The box and the hit target are the two fields only a layout engine has. The fake supplies
    // them so the CDP path exercises the fields `driver-parity.test.ts` pins as the divergence.
    const browser = fakeCdpBrowser({ ...PAGE, covered: ['#pay'] });
    const target = await openOver(browser);

    expect((await target.query('a'))[0]).toMatchObject({
      box: { x: 10, y: 10, width: 100, height: 20 },
      hitTarget: true,
    });
    expect((await target.query('#pay'))[0]?.hitTarget).toBe(false);
  });

  test('session() reads the seeded storage and user agent back off the page', async () => {
    const browser = fakeCdpBrowser({
      ...PAGE,
      storage: { token: 'bearer-abc' },
      userAgent: 'ultimate-scraper/1',
    });
    const target = await openOver(browser);
    expect(await target.session()).toMatchObject({
      storage: { token: 'bearer-abc' },
      userAgent: 'ultimate-scraper/1',
      origin: 'https://shop.test',
    });
  });

  test('type and select resolve without touching the DOM the fake parses', async () => {
    const browser = fakeCdpBrowser(PAGE);
    const target = await openOver(browser);
    await target.type('#email', 'a@b.test');
    await target.select('#size', ['m']);
    // The point is that neither throws and neither navigates: the fake has no form model, and
    // pretending otherwise is what `driver-parity.test.ts` would catch.
    expect(target.url()).toBe('https://shop.test/orders');
  });

  test('screenshot and pdf answer bytes, so the artifact path has something to write', async () => {
    const browser = fakeCdpBrowser(PAGE);
    const target = await openOver(browser);
    expect([...(await target.screenshot({ fullPage: true, timeoutMs: 1_000 }))]).toEqual([1, 2, 3]);
    expect([...(await target.pdf({ timeoutMs: 1_000 }))]).toEqual([4, 5]);
  });
});

describe('unit · fakeCdpLauncher', () => {
  test('launch and connect both answer the SAME browser the caller can assert on', async () => {
    const launcher = fakeCdpLauncher(PAGE);
    expect(await launcher.launch?.({})).toBe(launcher.browser);
    expect(await launcher.connect?.({})).toBe(launcher.browser);
  });
});
