/** Errors the orgs feature can raise. */

// No `docs:` at any declaration below. `UltimateError` fills it from
// `describeErrorCode(code).docs`, which is `@ultimat3/core`'s `ERROR_DOCS_URL` — one page for
// every code, never one per code, because a code lives on that page in a TABLE ROW and a row has
// no anchor. The `https://ultimate.dev/errors/<code>` links these classes built until 2026-08-23
// answered 404, host included, on every error this app has ever thrown.

import { defineError } from '@ultimat3/core/page';

export const OrgNotFound = defineError<string>({
  code: 'X_ORG_NOT_FOUND',
  title: 'no such organisation',
  status: 404,
  cause: (orgId) => `organisation ${JSON.stringify(orgId)} does not exist`,
  fix:
    'sign out and back in so the session carries a live org; ' +
    'in a test, take the org from seed("dev") in scripts/test-setup.ts',
});

export const AvatarKeyOutsideOrg = defineError<string>({
  code: 'X_AVATAR_KEY_OUTSIDE_ORG',
  title: 'the avatar key is not inside the org the job runs for',
  status: 422,
  cause: (key) =>
    `warmAvatar was queued with ${JSON.stringify(key)}, which is not under the org its input names, so it would decode another tenant's upload`,
  fix: 'enqueue warmAvatar with the key grantUpload answered for that org: warmAvatar.enqueue({ orgId, key: grant.key })',
});
