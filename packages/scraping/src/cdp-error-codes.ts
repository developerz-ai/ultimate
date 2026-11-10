// The registry for the raw-CDP browser's four `X_CDP_*` codes — the launcher, the connection and
// the calls over it. Owned here since 31.0.0, when the launcher moved from `@ultimat3/testing` to
// its runtime home; `@ultimat3/testing` re-reads these titles and registers only its own `X_E2E_*`.
import { registerErrorCodes } from '@ultimat3/core';

// Four and not one, because the four repairs differ: install a browser, read the browser's own
// stderr, look at the page, raise a deadline.
export const CDP_ERROR_CODES = [
  'X_CDP_BROWSER_MISSING',
  'X_CDP_LAUNCH_FAILED',
  'X_CDP_CALL_FAILED',
  'X_CDP_TIMEOUT',
] as const;

export type CdpErrorCode = (typeof CDP_ERROR_CODES)[number];

export const CDP_ERROR_TITLES = Object.freeze<Record<CdpErrorCode, string>>({
  X_CDP_BROWSER_MISSING: 'no Chrome or Chromium is installed for the e2e driver to launch',
  X_CDP_LAUNCH_FAILED: 'the browser started and never announced a DevTools endpoint',
  X_CDP_CALL_FAILED: 'the browser refused a DevTools call',
  X_CDP_TIMEOUT: 'a DevTools call did not answer inside its deadline',
});

// Owned here and borrowed by nobody, so unconditional: a second package claiming one must fail as
// X_ERROR_CODE_DUPLICATE rather than quietly keep whichever title registered first.
registerErrorCodes(
  Object.fromEntries(Object.entries(CDP_ERROR_TITLES).map(([code, title]) => [code, { title }])),
);
