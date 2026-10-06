/**
 * unit — `./tools.ts` evaluated ALONE, against a fresh action registry: importing it must be
 * correct with nothing else booted, which a module-scope server was not — its gate refused at
 * import whenever `apps/web/api` had not registered `publishPost` first (root-run import order).
 * Building it with nothing registered is still refused, naming the gated tool: the gate never
 * builds a server that would run `publishPost` unconfirmed.
 */

import { resetRegistry } from '@ultimat3/action';
import { expect, test } from '@ultimat3/testing';

test('tools.ts imports cleanly into an empty registry, and the server is built only on call', async () => {
  resetRegistry();
  const { postlyMcp } = await import('./tools');
  expect(postlyMcp).toBeInstanceOf(Function);
  expect(() => postlyMcp()).toThrow(/X_MCP_CONFIRMATION_TOOL_UNKNOWN[\s\S]*publishPost/);
});
