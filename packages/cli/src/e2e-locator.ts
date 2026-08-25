// `LocatorLike` over a browser page: a handle that holds a SELECTION and resolves nothing until
// something asks. One round trip per question, and no waiting of its own — `toBeVisible()` owns
// the only retry budget in the harness and drives this by looking again.

import type { LocatorLike } from '@ultimat3/testing';
import { E2eLocatorAmbiguousError, E2eLocatorEmptyError } from './e2e-errors';
import type { E2eResolution, E2eSelection } from './e2e-selection';
import { markSelector, selectionExpression, unmarkExpression } from './e2e-selection';

/**
 * What a locator needs from the browser. Narrower than `ScrapePage` on purpose: three methods is
 * what a test has to stand up to prove the mapping, and `click` is taken from the page rather than
 * re-derived here so the actionability wait `@ultimat3/scraping` already performs is the one that
 * runs.
 */
export interface LocatablePage {
  evaluate(expression: string): Promise<unknown>;
  click(selector: string): Promise<void>;
  url(): string;
}

const readResolution = (raw: unknown): E2eResolution => {
  const decoded = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  const held = decoded as { count?: unknown; visible?: unknown; marked?: unknown };
  return {
    count: typeof held?.count === 'number' ? held.count : 0,
    visible: held?.visible === true,
    marked: held?.marked === true,
  };
};

/**
 * One mark per click, never a constant: two locators marking the same page at once would each
 * click whichever element the other had just tagged. Seeded from a counter and not from
 * `Math.random()`, which `bun run flight-copies` refuses in shipped source and which would make
 * two runs of one test address two different elements.
 */
let marks = 0;
const nextMark = (): string => {
  marks += 1;
  return `m${String(marks)}`;
};

/** Test seam: the counter is process-global, so a test that asserts a mark resets it first. */
export const resetLocatorMarks = (): void => {
  marks = 0;
};

/**
 * Nothing is cached. A locator taken before a navigation must address the page that is there when
 * it is USED — the same rule `ScrapeFrame` states for a frame handle — so every method below
 * re-resolves, and a handle can never go stale behind the caller's back.
 */
export function e2eLocator(page: LocatablePage, selection: E2eSelection): LocatorLike {
  const resolve = async (mark?: string): Promise<E2eResolution> =>
    readResolution(await page.evaluate(selectionExpression(selection, mark)));

  return {
    count: async () => (await resolve()).count,
    /**
     * A point-in-time look, and deliberately not an ambiguity check: an assertion handed a locator
     * that matched three elements has an ANSWER — was the first one visible — and a refusal there
     * would turn `expect(...).toBeVisible()` into a crash rather than a verdict. Only `click`
     * refuses, because only `click` has to pick one.
     */
    isVisible: async () => (await resolve()).visible,
    first: () => e2eLocator(page, { ...selection, first: true }),
    click: async () => {
      const mark = nextMark();
      const resolution = await resolve(mark);
      if (resolution.count === 0) {
        throw new E2eLocatorEmptyError({ selection, url: page.url() });
      }
      if (resolution.count > 1 && !selection.first) {
        throw new E2eLocatorAmbiguousError({ selection, count: resolution.count });
      }
      try {
        await page.click(markSelector(mark));
      } finally {
        // Best effort, and never allowed to replace the click's own failure: a click that
        // navigated took the whole document — attribute included — with it.
        await page.evaluate(unmarkExpression(mark)).catch(() => undefined);
      }
    },
  };
}
