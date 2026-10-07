/**
 * Where an org wants to hear about its posts: one receiver URL and the secret every delivery to it
 * is signed with. `secret` is `.sealed()` — the database holds ciphertext, a `where` on it does
 * not compile, and no serialiser carries it — and is read once per delivery attempt, never stored
 * anywhere else (`apps/web/app/webhooks/jobs.ts`).
 *
 * `disabledReason` is the delivery mechanism's verdict (`disableAfter` consecutive failures), and
 * the only thing that writes it. Nullable: `null` is an endpoint that takes deliveries.
 *
 * `slot` is the per-org cap, held by the DATABASE: one of `WEBHOOK_ENDPOINT_SLOTS`, unique per org,
 * so an org has at most that many endpoints however many requests race to add one. A count read
 * before the insert was the cap only for requests that did not overlap.
 */

import { entity, enumerated, invariant, text, timestamp, url, uuid } from '@ultimat3/entity';
import { orgs } from './orgs';

export const WEBHOOK_SECRET_MAX = 128;

/** The slots an org's endpoints occupy — its cap, as values the CHECK and the unique index hold. */
export const WEBHOOK_ENDPOINT_SLOTS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'] as const;
export type WebhookEndpointSlot = (typeof WEBHOOK_ENDPOINT_SLOTS)[number];
export const WEBHOOK_DISABLED_REASON_MAX = 200;

export const webhookEndpoints = entity('webhook_endpoints', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .references(() => orgs.id, { onDelete: 'cascade' })
      .tenant(),
    slot: enumerated(WEBHOOK_ENDPOINT_SLOTS),
    url: url(),
    secret: text({ max: WEBHOOK_SECRET_MAX }).sealed(),
    disabledReason: text({ max: WEBHOOK_DISABLED_REASON_MAX }).nullable(),
    createdAt: timestamp().defaultNow(),
  },
  invariants: (c) => [invariant('webhook_endpoint_slot_unique', c.unique(['orgId', 'slot']))],
  indexes: [{ on: ['orgId', 'createdAt'] }],
});

export type WebhookEndpoint = typeof webhookEndpoints.$row;
