/**
 * The only module that reads or writes `webhook_endpoints` and `webhook_deliveries`. Every
 * statement goes through the typed handle, which scopes it to the acting actor's org — on a
 * delivery, the org the webhook's `tenant` declared — and seals `secret` on the way in.
 */

import {
  db,
  type WebhookDelivery,
  type WebhookEndpoint,
  type WebhookEndpointSlot,
} from '@postly/db';
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

/** The slots the org's endpoints hold. Bounded by the slot list itself. */
export async function usedSlots(orgId: string): Promise<ReadonlySet<WebhookEndpointSlot>> {
  const rows = await db.webhookEndpoints
    .where({ orgId })
    .orderBy('createdAt')
    .limit(ENDPOINTS_PER_ORG)
    .all();
  return new Set(rows.map((row) => row.slot));
}

/** Revoke one endpoint of the org. Its deliveries cascade with it. Answers how many rows went. */
export function deleteEndpoint(orgId: string, id: string): Promise<number> {
  return db.webhookEndpoints.deleteWhere({ orgId, id });
}

export function insertEndpoint(row: {
  readonly orgId: string;
  readonly slot: WebhookEndpointSlot;
  readonly url: string;
  readonly secret: string;
}): Promise<WebhookEndpoint> {
  // Each column NAMED: a spread of a row drops `secret`, which is sealed and not enumerable.
  return db.webhookEndpoints.insert({
    orgId: row.orgId,
    slot: row.slot,
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
  return db.webhookDeliveries.where({ endpointId }).orderBy('seq', 'desc').limit(1).one();
}

export function insertDelivery(row: Omit<WebhookDelivery, 'id'>): Promise<WebhookDelivery> {
  return db.webhookDeliveries.insert(row);
}

/** One endpoint's attempts, newest first and bounded. */
export function deliveriesOf(
  endpointId: string,
  limit: number,
): Promise<readonly WebhookDelivery[]> {
  return db.webhookDeliveries.where({ endpointId }).orderBy('seq', 'desc').limit(limit).all();
}
