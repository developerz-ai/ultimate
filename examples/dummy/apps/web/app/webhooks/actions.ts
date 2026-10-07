/**
 * The webhooks feature's two commands — register a receiver, revoke one. Declarations only — the body delegates to `ctx.webhooks`.
 *
 * `t` comes from @ultimat3/action, not @ultimat3/schema: an action file imports one package.
 */

import { action, t } from '@ultimat3/action';
import { orgAdminister } from '../orgs/policy';
import { AddEndpointInput, EndpointIssued, RemoveEndpointInput } from './entity';

/**
 * Register a receiver for the org's `post.published` deliveries. The org's administrator's right —
 * an endpoint is where the org's publications are sent. No `mcp`: the answer carries the secret,
 * shown once, and a tool result is kept in a transcript.
 */
export const addWebhookEndpoint = action({
  input: AddEndpointInput,
  output: EndpointIssued,
  policy: orgAdminister,
  async handle({ input, ctx }) {
    return ctx.webhooks.addEndpoint(input);
  },
});

/**
 * Revoke a receiver — the only remedy for a leaked secret, so the same right that registers one:
 * the org's administrator. No `mcp`, as `addWebhookEndpoint` has none: an agent that can drop the
 * org's integrations is an agent a prompt can talk into dropping them.
 */
export const removeWebhookEndpoint = action({
  input: RemoveEndpointInput,
  output: t.object({ endpointId: t.uuid }),
  policy: orgAdminister,
  async handle({ input, ctx }) {
    return ctx.webhooks.removeEndpoint(input);
  },
});
