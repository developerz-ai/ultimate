/** Errors the orgs feature can raise. */

// No `docs:` at any declaration below. `UltimateError` fills it from
// `describeErrorCode(code).docs`, which is `@ultimat3/core`'s `ERROR_DOCS_URL` — one page for
// every code, never one per code, because a code lives on that page in a TABLE ROW and a row has
// no anchor. The `https://ultimate.dev/errors/<code>` links these classes built until 2026-08-23
// answered 404, host included, on every error this app has ever thrown.

import { defineError } from '@ultimat3/core';

export const OrgNotFound = defineError<string>({
  code: 'X_ORG_NOT_FOUND',
  title: 'no such organisation',
  status: 404,
  cause: (orgId) => `organisation ${JSON.stringify(orgId)} does not exist`,
  fix:
    'sign out and back in so the session carries a live org; ' +
    'in a test, take the org from seed("dev") in scripts/test-setup.ts',
});
