/**
 * The webhooks feature's rules, registered as `ctx.webhooks`: register a receiver, and fan a
 * publication out to every live one. No HTTP here, so the action, an MCP tool and a test all call
 * the same functions with the same actor.
 *
 * `(ctx)` is left unannotated for the reason `posts/service.ts` gives.
 */

import { memberOf, NotAMember } from '@postly/core';
import { WEBHOOK_ENDPOINT_SLOTS, type WebhookEndpoint } from '@postly/db';
import { defineService, isUltimateError } from '@ultimat3/core';
import type { PostView } from '../posts/entity';
import {
  type AddEndpointInput,
  ENDPOINTS_PER_ORG,
  type EndpointIssued,
  type RemoveEndpointInput,
} from './entity';
import { EndpointLimitReached, EndpointNotFound } from './errors';
import { postPublishedWebhook } from './jobs';
import { deleteEndpoint, insertEndpoint, liveEndpoints, usedSlots } from './repo';
import { screenEndpointUrl } from './url-screen';

/**
 * Tries at a free slot. Each loss is the unique index refusing a slot another add just TOOK, so
 * after the cap's worth of losses every slot is taken and the next read answers the limit — the
 * loop is bounded by the cap, and never waits.
 */
const SLOT_TRIES = ENDPOINTS_PER_ORG + 1;

/** The cap, held by `webhook_endpoint_slot_unique`: a slot taken is the database's 23505. */
const slotTaken = (error: unknown): boolean =>
  isUltimateError(error) && error.code === 'X_DB_UNIQUE_VIOLATION';

/** Take the org's lowest free slot. The DATABASE decides the race; this only picks a candidate. */
const insertInFreeSlot = async (row: {
  readonly orgId: string;
  readonly url: string;
  readonly secret: string;
}): Promise<WebhookEndpoint> => {
  for (let attempt = 1; ; attempt += 1) {
    const used = await usedSlots(row.orgId);
    const slot = WEBHOOK_ENDPOINT_SLOTS.find((candidate) => !used.has(candidate));
    if (slot === undefined) throw new EndpointLimitReached(row.orgId, ENDPOINTS_PER_ORG);
    try {
      return await insertEndpoint({ ...row, slot });
    } catch (error) {
      if (!slotTaken(error) || attempt >= SLOT_TRIES) throw error;
    }
  }
};

/** 32 random bytes, hex: the shared secret a receiver verifies every delivery with. */
const mintSecret = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');

export const webhooksService = defineService('webhooks', (ctx) => ({
  /**
   * A new receiver, and its secret — answered here once and never readable again. The URL is
   * screened before anything is written: one the delivery screen refuses would dead-letter every
   * publication, terminally and never on the ledger, so nothing would ever disable it.
   */
  async addEndpoint(input: AddEndpointInput): Promise<EndpointIssued> {
    screenEndpointUrl(input.url);
    const secret = mintSecret();
    const row = await insertInFreeSlot({ orgId: input.orgId, url: input.url, secret });
    return { id: row.id, url: row.url, secret };
  },

  /**
   * Revoke a receiver — the remedy for a leaked secret: the row and its secret go, its delivery
   * rows cascade, and a delivery still queued for it is `X_WEBHOOK_ENDPOINT_UNKNOWN`, terminal.
   * Registering again mints a new secret.
   */
  async removeEndpoint(input: RemoveEndpointInput): Promise<{ endpointId: string }> {
    if ((await deleteEndpoint(input.orgId, input.endpointId)) === 0) {
      throw new EndpointNotFound(input.endpointId);
    }
    return { endpointId: input.endpointId };
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
