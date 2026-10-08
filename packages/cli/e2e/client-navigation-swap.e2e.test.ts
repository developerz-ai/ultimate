// Client navigation in a real Chrome: the swap itself — head, stylesheets before paint, islands
// under an enforced CSP, persisted elements, forms, cancellation, error pages — and every answer
// that must be a full document load instead.
//
//   bun test packages/cli/e2e/client-navigation-swap.e2e.test.ts

import { describe, expect, test } from 'bun:test';
import {
  base,
  click,
  currentTab,
  MARK,
  noBrowser,
  ran,
  read,
  sameDocument,
  start,
  TIMEOUT_MS,
  useBrowser,
} from './client-navigation-fixture';

describe.skipIf(noBrowser)('client navigation · the swap and its fallbacks', () => {
  useBrowser();

  // ── The fallbacks and the swap itself ────────────────────────────────────────────────────────
  test.each([
    ['another surface', 'to-site', 'Site'],
    ['data-x-reload', 'to-reload', 'B'],
  ])(
    '%s is a full document load',
    async (_name, link, title) => {
      await start('/a');
      await click(link);
      await currentTab().waitFor(
        `window.__kept === undefined && document.title === ${JSON.stringify(title)}`,
        `${title} to load`,
      );
    },
    TIMEOUT_MS,
  );

  test(
    'a tab on another build is refused before any route runs, then loads for real',
    async () => {
      await start('/a');
      await read(
        `document.querySelector('meta[name="x-ultimate-build"]').setAttribute('content', 'b0')`,
      );
      await click('to-b');
      await currentTab().waitFor(
        'window.__kept === undefined && document.title === "B"',
        'the real load',
      );
      expect(ran).toEqual(['GET /b full']);
    },
    TIMEOUT_MS,
  );

  test(
    'a fragment on the same page is the browser scrolling, never a fetch',
    async () => {
      await start('/a');
      await click('to-hash');
      await currentTab().waitFor('location.hash === "#below"', 'the hash');
      expect(ran).toEqual([]);
      expect(await sameDocument()).toBe(true);
    },
    TIMEOUT_MS,
  );

  test(
    'a link swaps the document: title, head, body, URL — styles before paint, focus, announcement',
    async () => {
      await start('/a');
      await read(`document.addEventListener('ultimate:navigated', () => {
        window.__spacing = getComputedStyle(document.querySelector('h1')).letterSpacing;
      }, { once: true })`);
      await click('to-b');
      await currentTab().waitFor('window.__spacing !== undefined', 'the navigated event');
      expect(await sameDocument()).toBe(true);
      expect(await read('location.pathname')).toBe('/b');
      expect(await read('document.querySelectorAll("meta[name=description]").length')).toBe(1);
      expect(await read('window.__spacing')).toBe('3px');
      expect(ran).toEqual(['GET /b soft']);
      expect(await read('document.activeElement === document.querySelector("main")')).toBe(true);
      await currentTab().waitFor(
        '[...document.querySelectorAll("[aria-live=polite]")].some((el) => el.textContent === "B")',
        'the announcement',
      );
    },
    TIMEOUT_MS,
  );

  test(
    'islands under an enforced CSP: old disposed, new booted, the persisted one untouched',
    async () => {
      await start('/a');
      await click('to-b');
      await currentTab().waitFor(
        'window.__mounts && window.__mounts.includes("b")',
        'island b to mount',
      );
      expect(await read('window.__disposed')).toEqual(['a']);
      expect(await read('window.__mounts.filter((n) => n === "shell").length')).toBe(1);
    },
    TIMEOUT_MS,
  );

  test(
    'forms: a GET navigates to its query, a POST follows its 303 — in place, one execution',
    async () => {
      await start('/b');
      await read('document.getElementById("search").requestSubmit()');
      await currentTab().waitFor('document.title === "Search tutela"', 'the search page');
      await start('/b');
      await read('document.getElementById("post").requestSubmit()');
      await currentTab().waitFor('document.title === "Done ada"', 'the redirect target');
      expect(await read('location.pathname + location.search')).toBe('/done?name=ada');
      expect(await sameDocument()).toBe(true);
      expect(ran).toEqual(['POST /submit soft', 'GET /done soft']);
    },
    TIMEOUT_MS,
  );

  test(
    'a second navigation cancels the first — the slower answer is never swapped in',
    async () => {
      await start('/a');
      await click('to-slow');
      await Bun.sleep(100);
      await click('to-b');
      await currentTab().waitFor('document.title === "B"', 'B');
      await Bun.sleep(2_000);
      expect(await read('document.title + " " + location.pathname')).toBe('B /b');
      expect(await read('document.documentElement.hasAttribute("data-x-navigating")')).toBe(false);
    },
    TIMEOUT_MS,
  );

  test(
    'a 404 page of this surface is swapped in — it is the answer, not a reason to ask twice',
    async () => {
      await start('/a');
      await click('to-missing');
      await currentTab().waitFor('document.title === "Not found"', 'the error page');
      expect(await sameDocument()).toBe(true);
      expect(ran).toEqual(['GET /missing soft']);
    },
    TIMEOUT_MS,
  );
  test(
    'a swap that fails part-way is a real load of the page — never a half-replaced one',
    async () => {
      await start('/a');
      await read(`Document.prototype.adoptNode = () => { throw new TypeError('broken swap'); }`);
      await click('to-b');
      await currentTab().waitFor(
        'window.__kept === undefined && document.title === "B"',
        'the real load',
      );
    },
    TIMEOUT_MS,
  );

  test(
    "the head: the new page's script runs once, JSON-LD is replaced, the old page's sheet retired",
    async () => {
      await start('/a');
      await click('to-b');
      await currentTab().waitFor('document.title === "B"', 'B');
      await currentTab().waitFor('window.__headRan === 1', 'the head script');
      expect(
        await read(
          '[...document.querySelectorAll("script[type=\'application/ld+json\']")].map((s) => s.textContent)',
        ),
      ).toEqual(['{"name":"B"}']);
      expect(await read('document.querySelectorAll("link[href=\'/a.css\']").length')).toBe(0);
      expect(await read('document.querySelectorAll("link[href$=\'/b.css\']").length')).toBe(1);
      await click('to-a');
      await currentTab().waitFor('document.title === "A"', 'A');
      await click('to-b');
      await currentTab().waitFor('document.title === "B"', 'B again');
      expect(await read('window.__headRan')).toBe(1);
    },
    TIMEOUT_MS,
  );

  test(
    'a persisted sidebar keeps its node and moves its active item',
    async () => {
      await start('/a');
      await read('document.getElementById("kept").dataset.touched = "yes"');
      await click('to-b');
      await currentTab().waitFor('document.title === "B"', 'B');
      expect(await read('document.getElementById("kept").dataset.touched')).toBe('yes');
      expect(
        await read(
          '[...document.querySelectorAll("#kept nav a")].map((a) => a.getAttribute("href") + ":" + a.getAttribute("aria-current") + ":" + a.className)',
        ),
      ).toEqual(['/a:null:', '/b:page:on']);
    },
    TIMEOUT_MS,
  );

  test(
    "N7: a new page's inline head script runs once; leaving drops it; the theme-like shared one never re-runs",
    async () => {
      await start('/a');
      await click('to-b');
      await currentTab().waitFor('document.title === "B"', 'B');
      await currentTab().waitFor('window.__inlineRan === 1', 'the inline head script');
      await click('to-a');
      await currentTab().waitFor('document.title === "A"', 'A');
      expect(
        await read(
          '[...document.head.querySelectorAll("script:not([src])")].filter((s) => s.textContent.includes("__inlineRan")).length',
        ),
      ).toBe(0);
      expect(await read('window.__inlineRan')).toBe(1);
    },
    TIMEOUT_MS,
  );

  test(
    "a navigation: 'document' page carries no router: its links are the browser's, and the next soft page has one again",
    async () => {
      await currentTab().goto(`${base}/doc`);
      await currentTab().waitFor('document.title === "Doc"', 'the document page');
      expect(await read('window.__xNavigation === undefined')).toBe(true);
      expect(
        await read('document.querySelectorAll("script[src*=\'/_x/assets/navigation/\']").length'),
      ).toBe(0);
      await read(MARK);
      ran.length = 0;
      await click('to-b');
      await currentTab().waitFor(
        'window.__kept === undefined && document.title === "B"',
        'a full load',
      );
      expect(ran).toEqual(['GET /b full']);
      await currentTab().waitFor('window.__xNavigation !== undefined', 'the router, back');
      await read(MARK);
      ran.length = 0;
      await click('to-a');
      await currentTab().waitFor('document.title === "A"', 'A');
      expect(await sameDocument()).toBe(true);
      expect(ran).toEqual(['GET /a soft']);
    },
    TIMEOUT_MS,
  );
});
