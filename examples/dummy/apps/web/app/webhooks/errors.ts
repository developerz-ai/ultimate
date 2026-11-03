/** Errors the webhooks feature can raise. Codes are stable; the message names the fix. */

import { defineError } from '@ultimat3/core';

/** 409: the request is well formed, and the org's current state refuses it. */
export const EndpointLimitReached = defineError<{ readonly orgId: string; readonly limit: number }>(
  {
    code: 'X_ORG_ENDPOINT_LIMIT',
    title: 'the org holds the most webhook endpoints it may register',
    status: 409,
    cause: (p) =>
      `org ${p.orgId} already has ${p.limit} webhook endpoints, the most one org may register`,
    fix: (p) =>
      `removeWebhookEndpoint({ orgId: '${p.orgId}', endpointId }) — as the org's owner, for an endpoint the org no longer delivers to; that frees its slot`,
  },
);

/**
 * A receiver URL a delivery would never be allowed to open, refused when it is REGISTERED: the
 * delivery mechanism refuses it on every attempt (`X_WEBHOOK_ENDPOINT_INVALID`, terminal, never on
 * the ledger), so an endpoint accepted here would dead-letter every publication and never be
 * disabled. The reason names the rule, never the URL — a URL can carry a token.
 */
export const EndpointUrlRefused = defineError<string>({
  code: 'X_ORG_ENDPOINT_URL_REFUSED',
  title: 'the webhook receiver URL is not one a delivery may open',
  status: 422,
  cause: (reason) => `the webhook receiver URL ${reason}`,
  fix: "addWebhookEndpoint({ orgId, url: 'https://hooks.example.com/postly' }) — a public https:// receiver; http:// is accepted only in a local environment",
});

/** No receiver with this id in the acting org — never another org's, which is the same answer. */
export const EndpointNotFound = defineError<string>({
  code: 'X_ORG_ENDPOINT_NOT_FOUND',
  title: "no such webhook endpoint in the acting member's org",
  status: 404,
  cause: (endpointId) => `no webhook endpoint ${endpointId} in the acting member's org`,
  fix: 'psql "$DATABASE_URL" -c "SELECT id, url FROM webhook_endpoints WHERE org_id = \'<orgId>\'"',
});

/**
 * A billing event whose bytes verified and do not read as the event Postly expects. 400, because
 * the signature proved the vendor sent exactly this and a redelivery sends it again. The cause
 * names no byte of it: the body is `.sensitive()` on the queue, and a parser's message quotes it.
 */
export const BillingEventUnreadable = defineError<string>({
  code: 'X_BILLING_EVENT_UNREADABLE',
  title: 'a verified billing event is not the shape Postly reads',
  status: 400,
  cause: (reason) => `the billing event verified and ${reason}`,
  fix: 'x jobs list --name billing.events --json — compare the vendor payload docs with BillingEvent in apps/web/app/webhooks/jobs/billing-events-receiver.ts',
});
