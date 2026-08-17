/** Errors the orgs feature can raise. */

import { UltimateError } from '@ultimat3/core';

export class OrgNotFound extends UltimateError {
  constructor(orgId: string) {
    super({
      code: 'X_ORG_NOT_FOUND',
      cause: `organisation ${JSON.stringify(orgId)} does not exist`,
      fix:
        'sign out and back in so the session carries a live org; ' +
        'in a test, take the org from seed("dev") in scripts/test-setup.ts',
      docs: 'https://ultimate.dev/errors/X_ORG_NOT_FOUND',
    });
  }
}
