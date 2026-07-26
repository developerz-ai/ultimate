/** Errors the orgs feature can raise. */

import { UltimateError } from '@ultimat3/core';

export class OrgNotFound extends UltimateError {
  constructor(orgId: string) {
    super({
      code: 'X_ORG_NOT_FOUND',
      cause: `organisation ${JSON.stringify(orgId)} does not exist`,
      fix: 'the actor’s session points at a deleted org — sign out and back in, or run `x db seed dev`',
      docs: 'https://ultimate.dev/errors/X_ORG_NOT_FOUND',
    });
  }
}
