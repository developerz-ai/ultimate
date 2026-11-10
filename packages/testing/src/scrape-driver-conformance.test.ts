// The scrape-driver suite over the two offline drivers — `fakeBrowser` from memory,
// `fixtureBrowser` from a directory of recordings — and the proof it can fail: a driver whose
// `frame()` answers the parent page, so a password typed into an iframe'd login lands in the page
// around it.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory or recursive-remove API, so mkdtemp/rm come from node:fs.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
import type { ScrapeDriver, ScrapePage } from '@ultimat3/scraping';
import { fakeBrowser, fixtureBrowser } from '@ultimat3/scraping';
import { SCRAPE_DRIVER_CHECKS, scrapeDriverConformance } from './scrape-driver-conformance';
import {
  openOn,
  SCRAPE_CONFORMANCE_HTTP,
  SCRAPE_CONFORMANCE_PAGES,
  SCRAPE_CONFORMANCE_URLS,
} from './scrape-driver-conformance-site';
import { behavesLike } from './shared-examples';
import { testName } from './test-types';

/**
 */
const FILES: Readonly<Record<string, string>> = {
  [SCRAPE_CONFORMANCE_URLS.orders]: 'shop-test-orders.json',
  [SCRAPE_CONFORMANCE_URLS.second]: 'shop-test-orders-2.json',
  [SCRAPE_CONFORMANCE_URLS.login]: 'shop-test-login.json',
  [SCRAPE_CONFORMANCE_URLS.search]: 'shop-test-search.json',
  [SCRAPE_CONFORMANCE_URLS.api]: 'http-get-shop-test-api-orders-page-1.json',
};

let dir = '';

beforeAll(async () => {
  dir = await mkdtemp(`${tmpdir()}/ultimate-scrape-conformance-`);
  for (const recording of [...SCRAPE_CONFORMANCE_PAGES, ...SCRAPE_CONFORMANCE_HTTP]) {
    await writeFile(`${dir}/${FILES[recording.url]}`, JSON.stringify(recording));
  }
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe(testName('unit', 'the fake browser'), () => {
  behavesLike(scrapeDriverConformance, () =>
    fakeBrowser(SCRAPE_CONFORMANCE_PAGES, { http: SCRAPE_CONFORMANCE_HTTP }),
  );
});

describe(testName('unit', 'the fixture browser'), () => {
  behavesLike(scrapeDriverConformance, () => fixtureBrowser(dir));
});

/** The fake, with every frame handle answering the parent document: the spread-target defect. */
function frameBlind(): ScrapeDriver {
  const inner = fakeBrowser(SCRAPE_CONFORMANCE_PAGES, { http: SCRAPE_CONFORMANCE_HTTP });
  return {
    name: 'frame-blind',
    async open(init) {
      const session = await inner.open(init);
      const page = new Proxy(session.page, {
        get: (target, key, receiver): unknown =>
          key === 'frame' ? () => target : Reflect.get(target, key, receiver),
      }) satisfies ScrapePage;
      return { ...session, page, close: () => session.close() };
    },
  };
}

const check = (prefix: string) => {
  const found = SCRAPE_DRIVER_CHECKS.find((each) => each.name.startsWith(prefix));
  if (found === undefined) return expect.unreachable(`no scrape-driver check named ${prefix}`);
  return found;
};

describe(testName('unit', 'a driver that breaks the contract fails conformance'), () => {
  test('a frame handle that is the parent fails the frame checks, passes the page ones', async () => {
    const run = async (prefix: string): Promise<void> => {
      const session = await openOn(frameBlind());
      try {
        await check(prefix).run(session);
      } finally {
        await session.close();
      }
    };
    await run('text, values and count');
    await expect(run('a frame reads its OWN document')).rejects.toThrow();
    await expect(run('fill inside a frame')).rejects.toThrow();
  });

  test('every check has a name of its own', () => {
    const names = SCRAPE_DRIVER_CHECKS.map((each) => each.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
