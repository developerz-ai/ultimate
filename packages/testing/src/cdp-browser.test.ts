// The two doors, and the one difference between them. The composition itself — launch, connect,
// attach — is proved against a real Chrome by `e2e/cdp-browser.e2e.test.ts`; what belongs here is
// the rule a CI box with no browser depends on.

import { describe, expect, test } from 'bun:test';
import { openE2eBrowser, openE2eBrowserIfAvailable } from './cdp-browser';
import { CHROME_PATH_ENV } from './cdp-launch';

const NOWHERE = { [CHROME_PATH_ENV]: '/nonexistent/definitely-not-a-browser' };

describe('opening a browser on a machine that has none', () => {
  test('openE2eBrowserIfAvailable answers undefined, so the suite above it SKIPS', async () => {
    expect(await openE2eBrowserIfAvailable({ env: NOWHERE, timeoutMs: 1_000 })).toBeUndefined();
  });

  test('openE2eBrowser refuses by name, for a caller that has already decided it needs one', async () => {
    const thrown = await openE2eBrowser({ env: NOWHERE, timeoutMs: 1_000 }).catch(
      (error: unknown) => error,
    );

    expect((thrown as { code?: string }).code).toBe('X_CDP_BROWSER_MISSING');
  });
});
