/**
 * Every outbound delivery attempt, one row each — Postly's `WebhookLedger`
 * (`apps/web/app/webhooks/ledger.ts`). Appended and never updated: what happened on attempt 3 is a
 * fact. `consecutiveFailures` is the count the attempt LEFT the endpoint at, so the next attempt
 * reads one row rather than counting back through history, and a success resets it to 0.
 *
 * No response body: a receiver that echoes the request would write the payload into a second table
 * with a different retention. Retention of this one is Postly's decision, and today it is "kept".
 */

import { boolean, entity, integer, text, timestamp, uuid } from '@ultimat3/entity';
import { orgs } from './orgs';
import { webhookEndpoints } from './webhook-endpoints';

export const WEBHOOK_NAME_MAX = 80;
export const WEBHOOK_EVENT_ID_MAX = 128;
export const WEBHOOK_TOPIC_MAX = 80;
export const WEBHOOK_ERROR_MAX = 500;

export const webhookDeliveries = entity('webhook_deliveries', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .references(() => orgs.id, { onDelete: 'cascade' })
      .tenant(),
    endpointId: uuid().references(() => webhookEndpoints.id, { onDelete: 'cascade' }),
    webhook: text({ max: WEBHOOK_NAME_MAX }),
    eventId: text({ max: WEBHOOK_EVENT_ID_MAX }),
    topic: text({ max: WEBHOOK_TOPIC_MAX }),
    attempt: integer(),
    ok: boolean(),
    /** Nullable: no response at all — a refused connection, a timeout. */
    status: integer().nullable(),
    durationMs: integer(),
    /** Nullable: set on a failure only, rendered by the framework, never the receiver's body. */
    error: text({ max: WEBHOOK_ERROR_MAX }).nullable(),
    consecutiveFailures: integer(),
    at: timestamp(),
  },
  indexes: [{ on: ['orgId', 'endpointId', 'at'] }],
});

export type WebhookDelivery = typeof webhookDeliveries.$row;
