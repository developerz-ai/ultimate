// The launcher check, at session OPEN: every verb `ScrapeTarget` forwards to, present on the page
// and the browser, or `X_SCRAPE_LAUNCHER_INCOMPLETE` naming each missing one — before any verb.

import type {
  CdpBrowserLike,
  CdpBrowserVerb,
  CdpPageLike,
  CdpPageVerb,
  CompleteCdpBrowser,
  CompleteCdpPage,
} from './cdp-port';
import { launcherIncomplete } from './error-throws-session';

/**
 * The lists, typed against the unions in `cdp-port.ts`: `satisfies Record<…>` makes a verb added
 * to the union without a row here a compile error, so the check and the type cannot drift.
 */
const PAGE_VERBS = {
  keyboard: 'object',
  focus: 'function',
  evaluateOnNewDocument: 'function',
  createCDPSession: 'function',
  setOfflineMode: 'function',
  emulateMediaFeatures: 'function',
} as const satisfies Record<CdpPageVerb, 'object' | 'function'>;

const BROWSER_VERBS = {
  cookies: 'function',
  setCookie: 'function',
} as const satisfies Record<CdpBrowserVerb, 'function'>;

const missingFrom = (
  owner: object,
  label: string,
  verbs: Readonly<Record<string, 'object' | 'function'>>,
): string[] =>
  Object.entries(verbs)
    .filter(([name, kind]) => {
      const value: unknown = (owner as Record<string, unknown>)[name];
      return kind === 'object'
        ? typeof value !== 'object' || value === null
        : typeof value !== 'function';
    })
    .map(([name, kind]) => `${label}.${name}${kind === 'function' ? '()' : ''}`);

/** The page and browser, proven complete, or the refusal naming every member that is not there. */
export function completeSession(
  driver: string,
  browser: CdpBrowserLike,
  page: CdpPageLike,
): { readonly browser: CompleteCdpBrowser; readonly page: CompleteCdpPage } {
  const missing = [
    ...missingFrom(page, 'page', PAGE_VERBS),
    ...missingFrom(browser, 'browser', BROWSER_VERBS),
  ];
  if (missing.length > 0) throw launcherIncomplete(driver, missing);
  // Proven member by member above; the cast restates that proof as a type.
  return {
    browser: browser as CompleteCdpBrowser,
    page: page as CompleteCdpPage,
  };
}
