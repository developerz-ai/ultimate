/**
 * The webhooks feature's view schemas. The tables live in `@postly/db`; what an endpoint looks like
 * on the wire is this feature's. `EndpointView` names no `secret` — a `.sealed()` column in a view
 * is `X_ENTITY_SEALED_IN_VIEW` — and the secret is answered exactly once, by `addWebhookEndpoint`.
 *
 * `t` comes from @ultimat3/schema here: this file declares no primitive.
 */

import { webhookEndpoints } from '@postly/db';
import { type Infer, t } from '@ultimat3/schema';

/** How many receivers one org may register: a handful of integrations, never a broadcast list. */
export const ENDPOINTS_PER_ORG = 10;

export const EndpointView = webhookEndpoints.$view(['id', 'url', 'disabledReason', 'createdAt']);
export type EndpointView = typeof EndpointView.$row;

export const AddEndpointInput = t.object({ orgId: t.uuid, url: t.url });
export type AddEndpointInput = Infer<typeof AddEndpointInput>;

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
