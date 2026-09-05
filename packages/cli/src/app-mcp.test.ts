// The discovery behind the mount: `apps/<app>/mcp.ts` exports `mcp`, `app.config.ts` says whether
// and where, and the boot gets either one route or one instruction. One fixture directory PER
// CASE, because `import()` caches by path and a rewritten `mcp.ts` would answer with its first body.
import { afterAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; fixtures are joined to this file's directory.
import { join } from 'node:path';
import type { UltimateRequest } from '@ultimat3/http';
import { APP_MCP_ROUTE_NAME, appMcpMount } from './app-mcp';

const FIXTURES = join(import.meta.dir, '..', '.app-mcp-fixture');

const fixture = async (name: string, files: Readonly<Record<string, string>>): Promise<string> => {
  const root = join(FIXTURES, name);
  await rm(root, { recursive: true, force: true });
  for (const [path, contents] of Object.entries(files)) await Bun.write(join(root, path), contents);
  return root;
};

const configWith = (mcp: string): string => `export const config = { ai: { mcp: ${mcp} } };\n`;

/** The shape `defineAppMcp` returns, with a route that answers by its own hand. */
const MCP_WITH_ROUTE = `export const mcp = {
  server: {},
  tools: [],
  route: {
    method: 'POST',
    path: '/mcp',
    rateLimitClass: () => 'read',
    limits: { read: 1, write: 1, list: 1 },
    handle: async (request) => new Response('mcp:' + request.method),
  },
};
`;

const MCP_WITHOUT_ROUTE = 'export const mcp = { server: {}, tools: [], route: undefined };\n';

afterAll(async () => {
  await rm(FIXTURES, { recursive: true, force: true });
});

describe('appMcpMount', () => {
  test('mounts POST <config.ai.mcp.path> onto the exported route, self-authenticated', async () => {
    const root = await fixture('mounted', {
      'app.config.ts': configWith("{ expose: true, path: '/agent' }"),
      'apps/web/mcp.ts': MCP_WITH_ROUTE,
    });
    const mount = await appMcpMount(root);
    expect(mount.warning).toBeUndefined();
    expect(mount.path).toBe('/agent');
    const route = mount.routes[0];
    if (route === undefined) expect.unreachable('no route was mounted');
    expect(route.method).toBe('POST');
    expect(route.path).toBe('/agent');
    // The http pipeline must not pre-judge: the route reads its own bearer token.
    expect(route.meta).toEqual({ name: APP_MCP_ROUTE_NAME, auth: 'public', enforcedBy: 'handler' });
    const raw = new Request('http://app.test/agent', { method: 'POST' });
    const response = await route.handler({ raw } as unknown as UltimateRequest, {} as never);
    expect(await response.text()).toBe('mcp:POST');
  });

  test('expose true and no mcp.ts is one instruction, naming the file to write', async () => {
    const root = await fixture('missing', {
      'app.config.ts': configWith("{ expose: true, path: '/mcp' }"),
    });
    const mount = await appMcpMount(root);
    expect(mount.routes).toEqual([]);
    expect(mount.path).toBeNull();
    expect(mount.warning?.code).toBe('X_MCP_APP_UNMOUNTED');
    expect(mount.warning?.reason).toBe('missing');
    expect(mount.warning?.fix).toContain('apps/web/mcp.ts');
    expect(mount.warning?.fix).toContain('resolveToken');
  });

  test('an mcp.ts built without resolveToken has no route, and the instruction says so', async () => {
    const root = await fixture('no-route', {
      'app.config.ts': configWith("{ expose: true, path: '/mcp' }"),
      'apps/web/mcp.ts': MCP_WITHOUT_ROUTE,
    });
    const mount = await appMcpMount(root);
    expect(mount.routes).toEqual([]);
    expect(mount.warning?.reason).toBe('no-route');
    expect(mount.warning?.cause).toContain('apps/web/mcp.ts');
    expect(mount.warning?.fix).toContain('resolveToken');
  });

  test('expose false mounts nothing and warns about nothing, whatever the file says', async () => {
    const root = await fixture('off', {
      'app.config.ts': configWith("{ expose: false, path: '/mcp' }"),
      'apps/web/mcp.ts': MCP_WITH_ROUTE,
    });
    expect(await appMcpMount(root)).toEqual({ routes: [], path: null, warning: undefined });
  });

  test('a directory with no app.config.ts is not an app that exposes anything', async () => {
    const root = await fixture('no-config', { 'apps/web/mcp.ts': MCP_WITH_ROUTE });
    expect(await appMcpMount(root)).toEqual({ routes: [], path: null, warning: undefined });
  });
});
