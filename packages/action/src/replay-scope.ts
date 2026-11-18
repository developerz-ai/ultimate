/**
 * The server half of a queued write's binding: a request naming the principal it was queued by runs
 * only under that principal's session. The page cannot enforce this itself, because the cookie is
 * shared with tabs it cannot hear. A request naming nobody is every ordinary call, and passes.
 */

import { CLIENT_REPLAY_SCOPE_HEADER, clientScopeId, principalScopeName } from '@ultimat3/core';
import type { UltimateRequest } from '@ultimat3/http';
import { ReplayPrincipalMismatchError } from './errors-http';

/** What `assertReplayPrincipal` refuses with, as the OpenAPI operation publishes it. */
export const REPLAY_REFUSAL = 'X_REPLAY_PRINCIPAL_MISMATCH';

export function assertReplayPrincipal(req: UltimateRequest, name: string): void {
  const named = req.header(CLIENT_REPLAY_SCOPE_HEADER);
  if (named === null) return;
  const scope = clientScopeId(req.ctx.actor);
  if (named !== principalScopeName(scope === '' ? null : scope)) {
    throw new ReplayPrincipalMismatchError({ name });
  }
}
