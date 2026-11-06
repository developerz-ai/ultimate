// The audit of every RAW tab — a `session.newTab()` a suite drives itself, outside `e2eTest`.
// Every settled `goto`/`reload` reads the page, every tab the test drove is read once more at its
// end, and the findings fail that test from the preload's one `afterEach`. No suite opts in: the
// tab reports here because `cdp-e2e-session.ts` built it. The rules and the read are `e2e-a11y-run`'s.

import { afterEach } from 'bun:test';
import type { A11yAllow, A11yPagesRun } from './e2e-a11y-run';
import { a11yPagesRun, checkAllow, claimedThisTest, releaseClaims } from './e2e-a11y-run';
import type { E2eBrowserPage } from './e2e-page';

/** What the session tells this file about one tab it built. */
export interface AuditedTab {
  /** A settled navigation: read the document now, before the next one replaces it. */
  navigated(): Promise<void>;
  /** The test called the tab — it is read again at the test's end, so a dialog it opened counts. */
  used(): void;
  /** Closed by the test: nothing left to read at its end, and Chrome may still list the target. */
  closed(): void;
}

interface Watched {
  readonly tab: E2eBrowserPage;
  closed: boolean;
  /** False once the tab or its whole browser is gone: there is no page left to read. */
  readonly alive: () => Promise<boolean>;
}

/** The tabs the running test (or the `beforeAll` before it) called. Cleared at each test's end. */
const used = new Set<Watched>();
/** The process' set: a finding one test failed on is not told again by the next. */
const reported = new Set<string>();
let current: A11yPagesRun | undefined;
let installed = false;

const run = (): A11yPagesRun => {
  current ??= a11yPagesRun([], reported, 'tab');
  return current;
};

/** Register a tab the session just built. Its `goto` calls `navigated`, its every call `used`. */
export function auditTab(tab: E2eBrowserPage, alive: () => Promise<boolean>): AuditedTab {
  const entry: Watched = { tab, alive, closed: false };
  return {
    async navigated() {
      if (claimedThisTest(tab)) return;
      await run().check(tab);
      // No preload to fail the test at its end: fail it HERE, at the navigation, rather than
      // keeping findings nothing will ever tell — a silent skip would pass every page.
      if (!installed) endRun();
    },
    used() {
      used.add(entry);
    },
    closed() {
      entry.closed = true;
    },
  };
}

/**
 * The raw-tab test's reasoned exceptions — `e2eTest`'s `{ a11y: { allow } }`, for a test with no
 * options slot. Each entry needs a non-blank `because`, it covers the reads after the call, and it
 * ends with the test. Call it first in the test body, before the navigation that lands on it.
 */
export function allowA11y(entries: readonly A11yAllow[]): void {
  run().allow(checkAllow({ allow: entries }));
}

const endRun = (): void => {
  const ending = current;
  current = undefined;
  ending?.verdict();
};

/**
 * The end of one test: every tab it called is read as the test left it, and everything kept since
 * the last test fails THIS one. A tab whose browser closed has no page left to read; what its
 * navigations found is still told.
 */
export async function endTabA11y(): Promise<void> {
  const touched = [...used];
  try {
    for (const entry of touched) {
      if (claimedThisTest(entry.tab)) continue;
      if (entry.closed || !(await entry.alive())) continue;
      await run().check(entry.tab);
    }
    endRun();
  } finally {
    // After the reads, which call the tab too: the next test starts with nothing it touched.
    used.clear();
    current = undefined;
    releaseClaims();
  }
}

/**
 * The longest one test's end may take: three reads per tab, a handful of tabs. A literal, not
 * `DEFAULT_CDP_TIMEOUT_MS` times a count — `cdp-browser.ts` reaches this file through the session,
 * and the import back would be a cycle. Measured ends are tens of milliseconds.
 */
export const TAB_A11Y_END_MS = 120_000;

/**
 * Called by the preloads, once per process. In a preload, `afterEach` runs after every test of
 * every file — the only place a hook reaches a suite that wrote none (measured on Bun 1.4.4: one
 * registered from a library call inside `beforeAll` ran once, not per test).
 */
export function installTabA11yAudit(): void {
  if (installed) return;
  installed = true;
  afterEach(endTabA11y, TAB_A11Y_END_MS);
}
