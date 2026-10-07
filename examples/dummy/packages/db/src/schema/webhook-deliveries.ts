/**
 * Every outbound delivery attempt, one row each — Postly's `WebhookLedger`
 * (`apps/web/app/webhooks/ledger.ts`). Appended and never updated: what happened on attempt 3 is a
 * fact. `consecutiveFailures` is the count the attempt LEFT the endpoint at, so the next attempt
 * reads one row rather than counting back through history, and a success resets it to 0.
 *
 * `seq` numbers an endpoint's attempts from 1, and `(endpointId, seq)` is unique: two deliveries
 * to one endpoint that finish at once both read row N, and the database takes exactly one N+1 —
 * the other is refused and reads again (`ledger.ts`), so no failure is counted from a stale row.
 *
 * No response body: a receiver that echoes the request would write the payload into a second table
 * with a different retention. Retention of this one is Postly's decision, and today it is "kept".
 */

import { boolean, entity, integer, invariant, text, timestamp, uuid } from '@ultimat3/entity';
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
    seq: integer(),
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
  invariants: (c) => [
    invariant('webhook_delivery_seq_from_one', c.seq.atLeast(1)),
    invariant('webhook_delivery_seq_unique', c.unique(['endpointId', 'seq'])),
  ],
  indexes: [{ on: ['orgId', 'endpointId', 'seq'] }],
});

export type WebhookDelivery = typeof webhookDeliveries.$row;
