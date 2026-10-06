/**
 * Retention for Postly's own MCP state. `x_mcp_confirmations` takes one row per gated agent call
 * (`@postly/mcp`'s `confirmAgentPublish`) and nothing deletes one, so the table grows with every
 * request an agent ever made. `purge()` is the job factory for exactly that: one durable step per
 * target, one clock reading per pass, and at-least-once is safe because a replayed delete removes
 * rows that are already gone. `api/tasks.ts` fires it.
 *
 * `t` would come from @ultimat3/jobs; this file declares no input of its own.
 */

import { confirmationStore } from '@postly/mcp/confirmations';
import { purge } from '@ultimat3/jobs';

/**
 * How long a confirmation outlives its expiry: thirty days, so "who approved that publish?" is
 * answerable for a month after the call. A business decision, which is why it is the app's.
 */
export const CONFIRMATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export const purgeMcpConfirmations = purge({
  name: 'postly.mcp.purge',
  targets: () => [
    {
      name: 'x_mcp_confirmations',
      purgeExpired: (nowMs) => confirmationStore.purge(new Date(nowMs - CONFIRMATION_RETENTION_MS)),
    },
  ],
});
