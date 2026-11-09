// The endpoint is mounted and refusing: a route at /mcp, and a 401 for a request that carries no
// token or one nobody issued — before any tool, or the body, is read.
import { expect, unitTest } from '@ultimat3/testing';
import { mcp } from './mcp';

const post = (headers: Record<string, string>) =>
  new Request('http://localhost/mcp', { method: 'POST', headers, body: '{}' });

unitTest(
  'POST /mcp is mounted, and answers 401 without a key or with one nobody issued',
  async () => {
    const route = mcp.route;
    if (route === undefined) return expect.unreachable('apps/web/mcp.ts built no route');
    expect(route.path).toBe('/mcp');
    expect((await route.handle(post({}))).status).toBe(401);
    const forged = await route.handle(post({ authorization: 'Bearer xk_live_nobody' }));
    expect(forged.status).toBe(401);
  },
);
