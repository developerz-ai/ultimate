// The free functions over a harness tab or session refuse one the harness did not build: a
// hand-rolled `E2eTab` has no CDP session behind it, and driving it blind would be a TypeError.

import { expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { newBrowserContext } from './cdp-e2e-context';
import type { E2eTab } from './cdp-e2e-page';
import type { E2eSession } from './cdp-e2e-session';
import { addVirtualAuthenticator } from './cdp-e2e-webauthn';

const codeOf = async (work: () => Promise<unknown>): Promise<string> => {
  try {
    await work();
  } catch (error) {
    return isUltimateError(error) ? error.code : String(error);
  }
  return 'no refusal';
};

test('a tab or a session the harness did not build is refused by name', async () => {
  const tab = {} as E2eTab;
  const session = {} as E2eSession;
  expect(await codeOf(() => addVirtualAuthenticator(tab))).toBe('X_TEST_FIXTURE_UNAVAILABLE');
  expect(await codeOf(() => newBrowserContext(session))).toBe('X_TEST_FIXTURE_UNAVAILABLE');
});
