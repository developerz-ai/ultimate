// The `scrapeDriver` port's contract as shared examples: `behavesLike(scrapeDriverConformance, ()
// => driver)` — a driver serving `SCRAPE_CONFORMANCE_PAGES` and `SCRAPE_CONFORMANCE_HTTP`. Each
// check opens its own session the way a scrape does, and closes it whatever happens. Where drivers
// genuinely cannot agree, a check accepts the answer OR the coded refusal.

import { test } from 'bun:test';
import type { ScrapeDriver } from '@ultimat3/scraping';
import { SCRAPE_FRAME_CHECKS } from './scrape-driver-conformance-frame-checks';
import type { ScrapeDriverCheck } from './scrape-driver-conformance-page-checks';
import { SCRAPE_PAGE_CHECKS } from './scrape-driver-conformance-page-checks';
import { openOn } from './scrape-driver-conformance-site';
import type { SharedExamples } from './shared-examples';
import { sharedExamples } from './shared-examples';

export const SCRAPE_DRIVER_CHECKS: readonly ScrapeDriverCheck[] = [
  ...SCRAPE_PAGE_CHECKS,
  ...SCRAPE_FRAME_CHECKS,
];

export const scrapeDriverConformance: SharedExamples<ScrapeDriver> = sharedExamples(
  'a scrape driver',
  (subject) => {
    for (const check of SCRAPE_DRIVER_CHECKS) {
      test(check.name, async () => {
        const session = await openOn(subject());
        try {
          await check.run(session);
        } finally {
          await session.close();
        }
      });
    }
  },
);
