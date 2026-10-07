/**
 * The webhooks feature's view schemas. The tables live in `@postly/db`; what an endpoint looks like
 * on the wire is this feature's. `EndpointView` names no `secret` — a `.sealed()` column in a view
 * is `X_ENTITY_SEALED_IN_VIEW` — and the secret is answered exactly once, by `addWebhookEndpoint`.
 *
 * `t` comes from @ultimat3/schema here: this file declares no primitive.
 */

import { WEBHOOK_ENDPOINT_SLOTS, webhookEndpoints } from '@postly/db';
import { type Infer, t } from '@ultimat3/schema';

/**
 * How many receivers one org may register: a handful of integrations, never a broadcast list. The
 * table's slot list, so the number the service reports is the one the unique index enforces.
 */
export const ENDPOINTS_PER_ORG = WEBHOOK_ENDPOINT_SLOTS.length;

export const EndpointView = webhookEndpoints.$view(['id', 'url', 'disabledReason', 'createdAt']);
export type EndpointView = typeof EndpointView.$row;

export const AddEndpointInput = t.object({ orgId: t.uuid, url: t.url });
export type AddEndpointInput = Infer<typeof AddEndpointInput>;

/** Revoking a receiver — a leaked secret's only remedy: the row goes, and its deliveries with it. */
export const RemoveEndpointInput = t.object({ orgId: t.uuid, endpointId: t.uuid });
export type RemoveEndpointInput = Infer<typeof RemoveEndpointInput>;

/** Shown once: the receiver verifies every delivery with this secret, and it is never read back. */
export const EndpointIssued = t.object({ id: t.uuid, url: t.url, secret: t.string });
export type EndpointIssued = Infer<typeof EndpointIssued>;

/** What a `post.published` delivery carries: the facts of the publication, never the body. */
export interface PublishedPayload {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly publishedAt: string | null;
}
