// The registry for the browser-backed e2e driver's codes: the seven `X_E2E_*` a page refuses with,
// registered here (not in `errors.ts`, which sits at its ceiling). The four `X_CDP_*` its raw-CDP
// browser refuses with are `@ultimat3/scraping/cdp`'s since 31.0.0 — listed here, registered there.
import { registerErrorCodes } from '@ultimat3/core';
import { CDP_ERROR_CODES, CDP_ERROR_TITLES } from '@ultimat3/scraping/cdp';

const OWN_E2E_CODES = [
  'X_E2E_EVALUATE_UNSUPPORTED',
  'X_E2E_EVALUATE_CAPTURED',
  'X_E2E_EVALUATE_THREW',
  'X_E2E_LOCATOR_EMPTY',
  'X_E2E_LOCATOR_AMBIGUOUS',
  'X_E2E_SERVICE_WORKER_ABSENT',
  'X_E2E_APP_FAILED',
] as const;

type OwnE2eCode = (typeof OWN_E2E_CODES)[number];

/** Every code an e2e run can refuse with: this package's seven, then the browser's four. */
export const E2E_ERROR_CODES = [...OWN_E2E_CODES, ...CDP_ERROR_CODES] as const;

export type E2eErrorCode = (typeof E2E_ERROR_CODES)[number];

const OWN_E2E_TITLES = Object.freeze<Record<OwnE2eCode, string>>({
  X_E2E_EVALUATE_UNSUPPORTED: 'a page.evaluate() closure cannot be sent into the browser',
  X_E2E_EVALUATE_CAPTURED: 'a page.evaluate() closure named a binding the page does not have',
  X_E2E_EVALUATE_THREW: 'an expression an e2e page ran threw inside the browser',
  X_E2E_LOCATOR_EMPTY: 'an e2e locator matched no element',
  X_E2E_LOCATOR_AMBIGUOUS: 'an e2e locator matched more than one element and was asked to click',
  X_E2E_SERVICE_WORKER_ABSENT: 'no service worker took control of the page within the budget',
  X_E2E_APP_FAILED: 'the app an e2e run spawned did not come up',
});

export const E2E_ERROR_TITLES = Object.freeze<Record<E2eErrorCode, string>>({
  ...OWN_E2E_TITLES,
  ...CDP_ERROR_TITLES,
});

// Owned here and borrowed by nobody, so unconditional: a second package claiming one must fail as
// X_ERROR_CODE_DUPLICATE rather than quietly keep whichever title registered first.
registerErrorCodes(
  Object.fromEntries(Object.entries(OWN_E2E_TITLES).map(([code, title]) => [code, { title }])),
);
