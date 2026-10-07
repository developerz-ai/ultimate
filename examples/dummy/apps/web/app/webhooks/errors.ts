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

/**
 * A receiver URL a delivery would never be allowed to open, refused when it is REGISTERED: the
 * delivery mechanism refuses it on every attempt (`X_WEBHOOK_ENDPOINT_INVALID`, terminal, never on
 * the ledger), so an endpoint accepted here would dead-letter every publication and never be
 * disabled. The reason names the rule, never the URL — a URL can carry a token.
 */
export class EndpointUrlRefused extends UltimateError {
  constructor(reason: string) {
    super({
      code: 'X_ORG_ENDPOINT_URL_REFUSED',
      cause: `the webhook receiver URL ${reason}`,
      fix: "addWebhookEndpoint({ orgId, url: 'https://hooks.example.com/postly' }) — a public https:// receiver; http:// is accepted only in a local environment",
    });
  }
}

/** No receiver with this id in the acting org — never another org's, which is the same answer. */
export class EndpointNotFound extends UltimateError {
  constructor(endpointId: string) {
    super({
      code: 'X_ORG_ENDPOINT_NOT_FOUND',
      cause: `no webhook endpoint ${endpointId} in the acting member's org`,
      fix: 'psql "$DATABASE_URL" -c "SELECT id, url FROM webhook_endpoints WHERE org_id = \'<orgId>\'"',
    });
  }
}
