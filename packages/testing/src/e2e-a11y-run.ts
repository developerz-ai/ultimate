// One test's accessibility audit, for `e2eTest` and a raw tab (`e2e-a11y-tabs.ts`) alike: every
// settled navigation and the test's end read the tree and the probe, findings no reasoned `allow`
// covers are kept, and the test fails once with every element named. Rules: `e2e-a11y.ts`.
// `X_E2E_A11Y_VIOLATION` is registered in `errors.ts`; its constructors live here.

import { renderCauseValue, renderFixLiteral, UltimateError } from '@ultimat3/core';
import { navigatedAway } from './cdp-e2e-page';
import type { A11yFinding } from './e2e-a11y';
import { findingKey, probeExpression, probeFindings, ruleFor, treeFinding } from './e2e-a11y';
import type { E2eBrowserPage } from './e2e-page';
// Bare: the title `X_E2E_A11Y_VIOLATION` renders with is registered there.
import './errors';

/** One deliberate exception, and why. `selector` is CSS, matched by the page against the element. */
export interface A11yAllow {
  readonly role: string;
  readonly selector: string;
  readonly because: string;
}

/** What an `e2eTest` may say about its audit. There is no switch: only reasoned exceptions. */
export interface A11yOptions {
  readonly allow?: readonly A11yAllow[] | undefined;
}

const ALLOW_FIX =
  "e2eTest(name, body, { a11y: { allow: [{ role: 'button', selector: '#close', because: 'why this element is exempt' }] } })";

/** Who audited the page — so the fix names the place THAT test can say `allow`. */
export type A11yAuditor = 'e2eTest' | 'tab';

/** A page in this test failed the audit. The cause lists every element, deduplicated. */
export class E2eA11yViolationError extends UltimateError {
  constructor(findings: readonly A11yFinding[], auditor: A11yAuditor = 'e2eTest') {
    const listed = findings
      .map((f) => `${f.rule} ${f.role} ${renderCauseValue(f.html)} at ${renderCauseValue(f.url)}`)
      .join('; ');
    const role = renderFixLiteral(findings[0]?.role, "'<role>'");
    const entry = `[{ role: ${role}, selector: '<css>', because: '<why>' }]`;
    super({
      code: 'X_E2E_A11Y_VIOLATION',
      cause: `${String(findings.length)} element(s) a screen reader cannot use — name each one (visible text, aria-label, <label for>, alt; alt="" for a decorative image; a <title>, <html lang>, nothing focusable under aria-hidden), or allow it with a reason: ${listed}`,
      fix:
        auditor === 'tab'
          ? `allowA11y(${entry}) — in the test, before the navigation that lands on it`
          : `e2eTest(name, body, { a11y: { allow: ${entry} } })`,
      meta: { findings: findings.map(({ matches: _, ...told }) => told) },
    });
  }
}

/** An `allow` entry with no reason: an exception nobody can review is the global switch again. */
export class E2eA11yAllowUnreasonedError extends UltimateError {
  constructor(entry: unknown) {
    super({
      code: 'X_E2E_A11Y_VIOLATION',
      cause: `an a11y.allow entry has no role, selector or non-blank because: ${renderCauseValue(entry)}`,
      fix: ALLOW_FIX,
    });
  }
}

/** The page port cannot read the tree. Never a silent skip: that would pass every page. */
export class E2eA11yUnavailableError extends UltimateError {
  constructor() {
    super({
      code: 'X_TEST_FIXTURE_UNAVAILABLE',
      cause:
        'the page handed to installE2eDriver({ page }) has no accessibilityTree(), so no e2eTest can be audited — implement it on that E2eBrowserPage, or forward it from the wrapper; cdpE2eTab (packages/testing/src/cdp-e2e-page.ts) has one',
      fix: 'accessibilityTree: (request) => tab.accessibilityTree(request)',
    });
  }
}

const filled = (text: unknown): boolean => typeof text === 'string' && text.trim() !== '';

/** Every entry reasoned, or the test is refused before its body runs. */
export const checkAllow = (options: A11yOptions | undefined): readonly A11yAllow[] => {
  const allow = options?.allow ?? [];
  for (const entry of allow) {
    if (!filled(entry.role) || !filled(entry.selector) || !filled(entry.because)) {
      throw new E2eA11yAllowUnreasonedError(entry);
    }
  }
  return allow;
};

const allowed = (finding: A11yFinding, allow: readonly A11yAllow[]): boolean =>
  allow.some((entry) => entry.role === finding.role && finding.matches.includes(entry.selector));

/** The tree and the probe of the page as it is now: one round trip each, plus one per finding. */
const readPage = async (
  page: E2eBrowserPage,
  selectors: readonly string[],
): Promise<readonly A11yFinding[]> => {
  if (page.accessibilityTree === undefined) throw new E2eA11yUnavailableError();
  const url = page.url();
  // A tab nothing navigated (`about:blank`) is no app's page: it has no title and no lang to give.
  if (!/^https?:/.test(url)) return [];
  const probed = probeFindings(await page.evaluate(probeExpression(selectors)), url);
  if (probed === undefined) return [];
  const nodes = await page.accessibilityTree({
    describe: (node) => ruleFor(node) !== undefined,
    selectors,
  });
  const fromTree = nodes.filter((node) => ruleFor(node) !== undefined);
  return [...fromTree.map((node) => treeFinding(node, url)), ...probed];
};

export interface A11yRun {
  /** Audit the page now; findings are kept, never thrown here. */
  check(): Promise<void>;
  /** Throw `X_E2E_A11Y_VIOLATION` if anything was kept. */
  verdict(): void;
}

/** One test's findings over any number of pages: each `check(page)` reads one, `verdict` tells all. */
export interface A11yPagesRun {
  check(page: E2eBrowserPage): Promise<void>;
  /** More reasoned exceptions for THIS run: they cover the reads after this call. */
  allow(entries: readonly A11yAllow[]): void;
  verdict(): void;
}

/**
 * The pages an `e2eTest` runner audits itself, with its test's `allow`, until the test ends. The
 * raw-tab audit (`e2e-a11y-tabs.ts`) stands down for these, so one navigation is never judged twice
 * — once with the test's reasoned exceptions and once without them.
 */
const claimed = new Set<E2eBrowserPage>();

export const claimedThisTest = (page: E2eBrowserPage): boolean => claimed.has(page);

/** At a test's end: every page is the raw-tab audit's again. */
export const releaseClaims = (): void => claimed.clear();

/**
 * Findings across pages, for one test. `reported` is the SUITE's set: a finding another test
 * already failed on is not told twice, so a shared header with no name fails one test rather than
 * every one.
 */
export function a11yPagesRun(
  given: readonly A11yAllow[],
  reported: Set<string>,
  auditor: A11yAuditor = 'e2eTest',
): A11yPagesRun {
  const allow = [...given];
  let selectors = [...new Set(allow.map((entry) => entry.selector))];
  const kept = new Map<string, A11yFinding>();
  return {
    async check(page) {
      let findings: readonly A11yFinding[];
      try {
        findings = await readPage(page, selectors);
      } catch (error) {
        // A document that committed under the read is "not this document": read the new one once.
        if (!navigatedAway(error)) throw error;
        findings = await readPage(page, selectors);
      }
      for (const finding of findings) {
        const key = findingKey(finding);
        if (allowed(finding, allow) || reported.has(key)) continue;
        kept.set(key, finding);
      }
    },
    allow(entries) {
      allow.push(...entries);
      selectors = [...new Set(allow.map((entry) => entry.selector))];
    },
    verdict() {
      if (kept.size === 0) return;
      for (const key of kept.keys()) reported.add(key);
      const told = [...kept.values()];
      kept.clear();
      throw new E2eA11yViolationError(told, auditor);
    },
  };
}

/** One `e2eTest`'s audit of the one page it drives — claimed from the raw-tab audit until it ends. */
export function startA11yRun(
  page: E2eBrowserPage,
  allow: readonly A11yAllow[],
  reported: Set<string>,
): A11yRun {
  claimed.add(page);
  const run = a11yPagesRun(allow, reported);
  return { check: () => run.check(page), verdict: () => run.verdict() };
}
