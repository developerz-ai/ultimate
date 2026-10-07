/** Errors the webhooks feature can raise. Codes are stable; the message names the fix. */

import { UltimateError } from '@ultimat3/core';

export class EndpointLimitReached extends UltimateError {
  constructor(orgId: string, limit: number) {
    super({
      code: 'X_ORG_ENDPOINT_LIMIT',
      cause: `org ${orgId} already has ${limit} webhook endpoints, the most one org may register`,
      fix: `psql "$DATABASE_URL" -c "DELETE FROM webhook_endpoints WHERE org_id = '${orgId}' AND disabled_reason IS NOT NULL"`,
    });
  }
}
