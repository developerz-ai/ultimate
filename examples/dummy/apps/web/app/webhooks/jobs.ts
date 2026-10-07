/**
 * The deliveries Postly sends. `webhook()` is a factory over `job()`: one event to one endpoint,
 * signed, retried with backoff, disabled after `disableAfter` consecutive failures, and every
 * attempt written to `postlyWebhookLedger`. Which endpoints exist and what a payload says are
 * Postly's — the fan-out is `ctx.webhooks.announcePublished`, one enqueue per live endpoint.
 *
 * `t` would come from @ultimat3/jobs; a webhook's input is the factory's own.
 */

import { orgId as toOrgId, postId as toPostId } from '@postly/domain';
import { webhook } from '@ultimat3/jobs';
import type { PublishedPayload } from './entity';
import { postlyWebhookLedger } from './ledger';
import { endpointIn } from './repo';

/** The topic every receiver routes on. Postly's taxonomy, signed into each delivery. */
export const POST_PUBLISHED = 'post.published';

/**
 * A post went public. The event id IS the post id: a post is published once, so the receiver's
 * dedupe key is stable across every retry and every endpoint. The body is read per ATTEMPT from the
 * post itself — the event's bytes live in the app's own table, never on the queue row.
 */
export const postPublishedWebhook = webhook({
  name: 'posts.published.webhook',
  // The org that owns the endpoint, on every enqueue: the endpoint and the post are read under it.
  tenant: ({ orgId }) => orgId,
  ledger: postlyWebhookLedger,
  endpoint: async ({ endpointId, orgId }) => {
    // Absent only on a row this declaration never queues: `tenant` refuses one with no org first
    // (`X_JOB_TENANT_MISMATCH`). Typed `string | undefined` by the mechanism, so said here as "no
    // such endpoint" — the mechanism's own not-found path — rather than as a read under no org.
    if (orgId === undefined) return null;
    const row = await endpointIn(orgId, endpointId);
    // `secret` NAMED: it is sealed and not enumerable, so a spread of the row would drop it.
    return row === null
      ? null
      : { id: row.id, url: row.url, secret: row.secret, disabled: row.disabledReason !== null };
  },
  // `orgId` is the delivery's own, off its input — the org `tenant` above declared, handed over so
  // no read here has to learn it from the actor.
  event: async ({ eventId, orgId, ctx }) => {
    if (orgId === undefined) return null;
    const post = await ctx.posts.inOrg(toOrgId(orgId), toPostId(eventId));
    if (post === null || post.status !== 'published') return null;
    const payload: PublishedPayload = {
      id: post.id,
      slug: post.slug,
      title: post.title,
      // Machine data: an ISO 8601 UTC instant, never a date formatted for a reader.
      publishedAt: post.publishedAt === null ? null : post.publishedAt.toISOString(),
    };
    return { topic: POST_PUBLISHED, body: JSON.stringify(payload) };
  },
  retry: { attempts: 8, backoff: 'exponential' },
  // No `queue`: `default` is one `app.config.ts` already polls — a queue no worker claims from is
  // a delivery that waits forever.
  timeout: '30s',
});
