// The endpoint is mounted and refusing: a route at /mcp, and a 401 for a request that carries no
// token or one this process does not honour — before any tool, or the body, is read.
import { expect, unitTest } from '@ultimat3/testing';
import { DEV_AGENT_TOKEN_PREFIX } from './app/auth/agent-token';
import { mcp } from './mcp';

const post = (headers: Record<string, string>) =>
  new Request('http://localhost/mcp', { method: 'POST', headers, body: '{}' });

unitTest('POST /mcp is mounted, and answers 401 without a token', async () => {
  const route = mcp.route;
  if (route === undefined) return expect.unreachable('apps/web/mcp.ts built no route');
  expect(route.path).toBe('/mcp');
  const response = await route.handle(post({}));
  expect(response.status).toBe(401);
  // The development token is refused outside `x dev`: `bun test` is not development.
  const dev = await route.handle(post({ authorization: `Bearer ${DEV_AGENT_TOKEN_PREFIX}admin` }));
  expect(dev.status).toBe(401);
});
