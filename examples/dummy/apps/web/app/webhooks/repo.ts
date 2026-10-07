/**
 * The only module that reads or writes `webhook_endpoints` and `webhook_deliveries`. Every
 * statement goes through the typed handle, which scopes it to the acting actor's org — on a
 * delivery, the org the webhook's `tenant` declared — and seals `secret` on the way in.
 */

import { db, type WebhookDelivery, type WebhookEndpoint } from '@postly/db';
import { ENDPOINTS_PER_ORG } from './entity';

export function endpointById(id: string): Promise<WebhookEndpoint | null> {
  return db.webhookEndpoints.where({ id }).one();
}

/** The endpoint inside a NAMED org — a delivery's read, whose org is its own input. */
export function endpointIn(orgId: string, id: string): Promise<WebhookEndpoint | null> {
  return db.webhookEndpoints.where({ orgId, id }).one();
}

/** The org's receivers that still take deliveries, oldest first: the publish fan-out's list. */
export function liveEndpoints(orgId: string): Promise<readonly WebhookEndpoint[]> {
  return db.webhookEndpoints
    .where({ orgId, disabledReason: null })
    .orderBy('createdAt')
    .limit(ENDPOINTS_PER_ORG)
    .all();
}

export function endpointCount(orgId: string): Promise<number> {
  return db.webhookEndpoints.where({ orgId }).count();
}

export function insertEndpoint(row: {
  readonly orgId: string;
  readonly url: string;
  readonly secret: string;
}): Promise<WebhookEndpoint> {
  // Each column NAMED: a spread of a row drops `secret`, which is sealed and not enumerable.
  return db.webhookEndpoints.insert({
    orgId: row.orgId,
    url: row.url,
    secret: row.secret,
    disabledReason: null,
  });
}

/**
 * Switch an endpoint off, once. Filtered on `disabledReason: null`, so a second attempt that was
 * already in flight when the first crossed `disableAfter` changes nothing — the FIRST reason stays.
 */
export function disableEndpoint(id: string, reason: string): Promise<number> {
  return db.webhookEndpoints.updateWhere({ id, disabledReason: null }, { disabledReason: reason });
}

/** The endpoint's newest attempt — what the consecutive-failure count continues from. */
export function lastDelivery(endpointId: string): Promise<WebhookDelivery | null> {
  return db.webhookDeliveries.where({ endpointId }).orderBy('at', 'desc').limit(1).one();
}

export function insertDelivery(row: Omit<WebhookDelivery, 'id'>): Promise<WebhookDelivery> {
  return db.webhookDeliveries.insert(row);
}

/** One endpoint's attempts, newest first and bounded. */
export function deliveriesOf(
  endpointId: string,
  limit: number,
): Promise<readonly WebhookDelivery[]> {
  return db.webhookDeliveries.where({ endpointId }).orderBy('at', 'desc').limit(limit).all();
}
