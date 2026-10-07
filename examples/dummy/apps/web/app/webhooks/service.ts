/**
 * The webhooks feature's rules, registered as `ctx.webhooks`: register a receiver, and fan a
 * publication out to every live one. No HTTP here, so the action, an MCP tool and a test all call
 * the same functions with the same actor.
 *
 * `(ctx)` is left unannotated for the reason `posts/service.ts` gives.
 */

import { memberOf, NotAMember } from '@postly/core';
import { defineService } from '@ultimat3/core';
import type { PostView } from '../posts/entity';
import { type AddEndpointInput, ENDPOINTS_PER_ORG, type EndpointIssued } from './entity';
import { EndpointLimitReached } from './errors';
import { postPublishedWebhook } from './jobs';
import { endpointCount, insertEndpoint, liveEndpoints } from './repo';

/** 32 random bytes, hex: the shared secret a receiver verifies every delivery with. */
const mintSecret = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');

export const webhooksService = defineService('webhooks', (ctx) => ({
  /** A new receiver, and its secret — answered here once and never readable again. */
  async addEndpoint(input: AddEndpointInput): Promise<EndpointIssued> {
    if ((await endpointCount(input.orgId)) >= ENDPOINTS_PER_ORG) {
      throw new EndpointLimitReached(input.orgId, ENDPOINTS_PER_ORG);
    }
    const secret = mintSecret();
    const row = await insertEndpoint({ orgId: input.orgId, url: input.url, secret });
    return { id: row.id, url: row.url, secret };
  },

  /**
   * One delivery per live endpoint of the post's org, enqueued in the caller's transaction: a
   * rolled-back publish tells nobody. ONE endpoint per job, because retry and disable-after-N are
   * per-endpoint facts. The org is the acting member's, carried onto each delivery for `tenant`.
   */
  async announcePublished(post: PostView): Promise<number> {
    const member = memberOf(ctx.actor);
    if (member === null) throw new NotAMember(ctx.actor.id);
    const endpoints = await liveEndpoints(member.orgId);
    for (const endpoint of endpoints) {
      await postPublishedWebhook.enqueue({
        endpointId: endpoint.id,
        eventId: post.id,
        orgId: member.orgId,
      });
    }
    return endpoints.length;
  },
}));
