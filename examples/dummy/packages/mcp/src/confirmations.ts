/**
 * The MCP tools an agent may call only after a person says yes — `mcpConfirmations()`, a factory
 * over `action`: what it returns IS the decision action, registered in `apps/web/api` like any
 * other (route, OpenAPI, typed client), and `defineAppMcp({ confirmations })` in `./tools.ts` gates
 * the named tools with it.
 *
 * Its own module, never folded into `tools.ts`: the API registers the decision action at boot, and
 * importing `tools.ts` there would snapshot the action registry before the actions it gates exist.
 */

import { storeMode } from '@ultimat3/core';
import { dbExecutor } from '@ultimat3/db';
import {
  type McpConfirmationStore,
  mcpConfirmations,
  memoryConfirmationStore,
  postgresConfirmationStore,
} from '@ultimat3/mcp';

/**
 * Pending and decided confirmations, in `x_mcp_confirmations` (a framework table the boot applies),
 * through `@ultimat3/db`'s one executor builder: it resolves the client per statement, so it
 * reaches the boot's and, inside a transaction, the transaction's. In memory under `bun test` only, by the rule `@postly/db`'s driver follows (`storeMode`): a fleet
 * whose replicas each held their own would ask a person on one and run the call on another.
 */
export const confirmationStore: McpConfirmationStore =
  storeMode(Bun.env) === 'memory'
    ? memoryConfirmationStore()
    : postgresConfirmationStore({ executor: dbExecutor() });

/**
 * Publishing puts a post in front of the whole org and onto the public blog. An agent may draft
 * and comment on its own; `publishPost` waits for a member who holds `post:publish` in the same
 * org to view the exact call and approve it. Decided by a person only — an agent can never approve
 * its own request, whatever it holds — and the approved call still runs through `postPublish`.
 */
export const confirmAgentPublish = mcpConfirmations({
  tools: ['publishPost'],
  store: confirmationStore,
  permission: 'post:publish',
});
