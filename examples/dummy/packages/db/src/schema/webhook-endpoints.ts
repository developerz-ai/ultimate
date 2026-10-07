/**
 * Where an org wants to hear about its posts: one receiver URL and the secret every delivery to it
 * is signed with. `secret` is `.sealed()` — the database holds ciphertext, a `where` on it does
 * not compile, and no serialiser carries it — and is read once per delivery attempt, never stored
 * anywhere else (`apps/web/app/webhooks/jobs.ts`).
 *
 * `disabledReason` is the delivery mechanism's verdict (`disableAfter` consecutive failures), and
 * the only thing that writes it. Nullable: `null` is an endpoint that takes deliveries.
 */

import { entity, text, timestamp, url, uuid } from '@ultimat3/entity';
import { orgs } from './orgs';

export const WEBHOOK_SECRET_MAX = 128;
export const WEBHOOK_DISABLED_REASON_MAX = 200;

export const webhookEndpoints = entity('webhook_endpoints', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .references(() => orgs.id, { onDelete: 'cascade' })
      .tenant(),
    url: url(),
    secret: text({ max: WEBHOOK_SECRET_MAX }).sealed(),
    disabledReason: text({ max: WEBHOOK_DISABLED_REASON_MAX }).nullable(),
    createdAt: timestamp().defaultNow(),
  },
  indexes: [{ on: ['orgId', 'createdAt'] }],
});

export type WebhookEndpoint = typeof webhookEndpoints.$row;
