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

/**
 * The actor carries no membership, so no rule in this feature can decide about them. Every
 * action here is gated by a policy that already refuses that actor — this is the service's own
 * refusal for a caller that arrived from a job or a test instead of through one.
 */
export class NotAMember extends UltimateError {
  constructor(actorId: string) {
    super({
      code: 'X_ORG_NOT_A_MEMBER',
      cause: `actor ${JSON.stringify(actorId)} carries no org and no membership role`,
      // Runnable, not advice: the caller either has a membership row or does not, and this is the
      // statement that answers it. `actorFor(member)` is what a test does with the row it finds.
      fix:
        'confirm the caller has a membership row, then build the actor with actorFor(member): ' +
        `x db query "select id, org_id, role from members where id = '${actorId}'" --json`,
      docs: 'https://ultimate.dev/errors/X_ORG_NOT_A_MEMBER',
    });
  }
}
