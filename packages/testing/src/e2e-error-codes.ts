// The registry for the browser-backed e2e driver's codes: the seven `X_E2E_*` a page refuses with
// and the four `X_CDP_*` its raw-CDP browser refuses with. Registered here, not in `errors.ts`,
// because that catalogue sits at its ceiling; anchored by the barrel and by both constructor files.
import { registerErrorCodes } from '@ultimat3/core';

export const E2E_ERROR_CODES = [
  'X_E2E_EVALUATE_UNSUPPORTED',
  'X_E2E_EVALUATE_CAPTURED',
  'X_E2E_EVALUATE_THREW',
  'X_E2E_LOCATOR_EMPTY',
  'X_E2E_LOCATOR_AMBIGUOUS',
  'X_E2E_SERVICE_WORKER_ABSENT',
  'X_E2E_APP_FAILED',
  // Four and not one, because the four repairs differ: install a browser, read the browser's own
  // stderr, look at the page, raise a deadline.
  'X_CDP_BROWSER_MISSING',
  'X_CDP_LAUNCH_FAILED',
  'X_CDP_CALL_FAILED',
  'X_CDP_TIMEOUT',
] as const;

export type E2eErrorCode = (typeof E2E_ERROR_CODES)[number];

export const E2E_ERROR_TITLES = Object.freeze<Record<E2eErrorCode, string>>({
  X_E2E_EVALUATE_UNSUPPORTED: 'a page.evaluate() closure cannot be sent into the browser',
  X_E2E_EVALUATE_CAPTURED: 'a page.evaluate() closure named a binding the page does not have',
  X_E2E_EVALUATE_THREW: 'an expression an e2e page ran threw inside the browser',
  X_E2E_LOCATOR_EMPTY: 'an e2e locator matched no element',
  X_E2E_LOCATOR_AMBIGUOUS: 'an e2e locator matched more than one element and was asked to click',
  X_E2E_SERVICE_WORKER_ABSENT: 'no service worker took control of the page within the budget',
  X_E2E_APP_FAILED: 'the app an e2e run spawned did not come up',
  X_CDP_BROWSER_MISSING: 'no Chrome or Chromium is installed for the e2e driver to launch',
  X_CDP_LAUNCH_FAILED: 'the browser started and never announced a DevTools endpoint',
  X_CDP_CALL_FAILED: 'the browser refused a DevTools call',
  X_CDP_TIMEOUT: 'a DevTools call did not answer inside its deadline',
});

// Owned here and borrowed by nobody, so unconditional: a second package claiming one must fail as
// X_ERROR_CODE_DUPLICATE rather than quietly keep whichever title registered first.
registerErrorCodes(
  Object.fromEntries(Object.entries(E2E_ERROR_TITLES).map(([code, title]) => [code, { title }])),
);
