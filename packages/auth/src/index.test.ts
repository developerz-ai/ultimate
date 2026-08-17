// The public surface this package's README promises. A name the README documents and `index.ts`
// does not re-export is a call an app cannot make — the failure this file exists to catch.

import { describe, expect, test } from 'bun:test';
import * as auth from './index';
import { BUILTIN_OAUTH_PROVIDER_IDS as declared } from './oauth-builtins';

describe('@ultimat3/auth public surface', () => {
  test('re-exports `BUILTIN_OAUTH_PROVIDER_IDS`, the list README.md tells an app to read', () => {
    expect(auth.BUILTIN_OAUTH_PROVIDER_IDS).toBe(declared);
  });

  test('it is the three shipped ids, frozen', () => {
    expect([...auth.BUILTIN_OAUTH_PROVIDER_IDS]).toEqual(['github', 'google', 'apple']);
    expect(Object.isFrozen(auth.BUILTIN_OAUTH_PROVIDER_IDS)).toBe(true);
  });
});
