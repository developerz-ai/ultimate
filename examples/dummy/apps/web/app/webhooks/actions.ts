/**
 * The webhooks feature's one command. Declarations only — the body delegates to `ctx.webhooks`.
 *
 * `t` comes from @ultimat3/action, not @ultimat3/schema: an action file imports one package.
 */

import { action } from '@ultimat3/action';
import { orgAdminister } from '../orgs/policy';
import { AddEndpointInput, EndpointIssued } from './entity';

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
