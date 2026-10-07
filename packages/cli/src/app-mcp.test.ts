// The discovery behind the mount: `apps/<app>/mcp.ts` exports `mcp` and says where, `app.config.ts`
// says whether, and the boot gets either one route or one instruction. One fixture directory PER
// CASE, because `import()` caches by path and a rewritten `mcp.ts` would answer with its first body.
import { afterAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no tmpdir(); a fixture lives outside the checkout, where a parallel worker
// globbing the tree cannot meet it half-deleted.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; fixtures are joined to this file's directory.
import { join } from 'node:path';
import type { UltimateRequest } from '@ultimat3/http';
import { APP_MCP_ROUTE_NAME, appMcpMount, mountAppMcp } from './app-mcp';

const FIXTURES = join(tmpdir(), `x-app-mcp-${process.pid}`);

const fixture = async (name: string, files: Readonly<Record<string, string>>): Promise<string> => {
  const root = join(FIXTURES, name);
  await rm(root, { recursive: true, force: true });
  for (const [path, contents] of Object.entries(files)) await Bun.write(join(root, path), contents);
  return root;
};

const configWith = (mcp: string): string =>
  `export const config = { name: 'demo', ai: { mcp: ${mcp} } };\n`;

/** The shape `defineAppMcp` returns, with a route that answers by its own hand. */
const mcpWithRoute = (path: string): string => `export const mcp = {
  server: {},
  tools: [],
  route: {
    method: 'POST',
    path: '${path}',
    rateLimitClass: () => 'read',
    limits: { read: 1, write: 1, list: 1 },
    handle: async (request) => new Response('mcp:' + request.method),
  },
};
`;

const MCP_WITH_ROUTE = mcpWithRoute('/mcp');

const MCP_WITHOUT_ROUTE = 'export const mcp = { server: {}, tools: [], route: undefined };\n';

afterAll(async () => {
  await rm(FIXTURES, { recursive: true, force: true });
});

describe('appMcpMount', () => {
  test("mounts POST <the route's own path> onto the exported route, self-authenticated", async () => {
    const root = await fixture('mounted', {
      'app.config.ts': configWith('{ expose: true }'),
      'apps/web/mcp.ts': mcpWithRoute('/agent'),
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
    const ctx = { url: new URL(raw.url), https: true } as never;
    const response = await route.handler({ raw } as unknown as UltimateRequest, ctx);
    expect(await response.text()).toBe('mcp:POST');
  });

  test('hands the route the PUBLIC origin, and serves the oauth metadata when declared', async () => {
    const root = await fixture('oauth', {
      'app.config.ts': configWith('{ expose: true }'),
      'apps/web/mcp.ts': `export const mcp = {
  server: {},
  tools: [],
  route: {
    method: 'POST',
    path: '/mcp',
    rateLimitClass: () => 'read',
    limits: { read: 1, write: 1 },
    protectedResource: {
      paths: ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource'],
      document: (origin) => ({ resource: origin + '/mcp', authorization_servers: [origin] }),
    },
    handle: async (_request, seen) => new Response(seen.origin),
  },
};
`,
    });
    const mount = await appMcpMount(root);
    expect(mount.routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      'POST /mcp',
      'GET /.well-known/oauth-protected-resource/mcp',
      'GET /.well-known/oauth-protected-resource',
    ]);
    // Behind a TLS-terminating ingress: an http:// internal URL, and ctx.https affirmed.
    const raw = new Request('http://www.example.com/mcp', { method: 'POST' });
    const ctx = { url: new URL(raw.url), https: true } as never;
    const [post, metadata] = mount.routes;
    if (post === undefined || metadata === undefined) return expect.unreachable('routes mounted');
    const answered = await post.handler({ raw } as unknown as UltimateRequest, ctx);
    expect(await answered.text()).toBe('https://www.example.com');
    const document = await metadata.handler({ raw } as unknown as UltimateRequest, ctx);
    expect(await document.json()).toEqual({
      resource: 'https://www.example.com/mcp',
      authorization_servers: ['https://www.example.com'],
    });
    expect(document.headers.get('access-control-allow-origin')).toBe('*');
    expect(metadata.meta.auth).toBe('public');
  });

  test('expose true and no mcp.ts is one instruction, naming the file to write', async () => {
    const root = await fixture('missing', {
      'app.config.ts': configWith('{ expose: true }'),
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
      'app.config.ts': configWith('{ expose: true }'),
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
      'app.config.ts': configWith('{ expose: false }'),
      'apps/web/mcp.ts': MCP_WITH_ROUTE,
    });
    expect(await appMcpMount(root)).toEqual({
      routes: [],
      path: null,
      paths: [],
      warning: undefined,
    });
  });

  test('a directory with no app.config.ts is not an app that exposes anything', async () => {
    const root = await fixture('no-config', { 'apps/web/mcp.ts': MCP_WITH_ROUTE });
    expect(await appMcpMount(root)).toEqual({
      routes: [],
      path: null,
      paths: [],
      warning: undefined,
    });
  });

  test('an mcp.ts that exports no `mcp` is the missing case, and the instruction names that file', async () => {
    const root = await fixture('other-export', {
      'app.config.ts': configWith('{ expose: true }'),
      'apps/web/mcp.ts': 'export const tools = [];\n',
    });
    const mount = await appMcpMount(root);
    expect(mount.routes).toEqual([]);
    expect(mount.warning?.reason).toBe('missing');
    expect(mount.warning?.cause).toContain('apps/web/mcp.ts');
  });

  // 25.0.0: the path is `defineAppMcp`'s alone. A config still naming one is refused at the
  // loader, never quietly obeyed over the endpoint's own — nor quietly ignored.
  test('a config still writing ai.mcp.path is refused, naming defineAppMcp({ path })', async () => {
    const root = await fixture('stale-path', {
      'app.config.ts': configWith("{ expose: true, path: '/agent' }"),
      'apps/web/mcp.ts': MCP_WITH_ROUTE,
    });
    try {
      await appMcpMount(root);
    } catch (thrown) {
      const error = thrown as { code: string; cause: string; fix: string };
      expect(error.code).toBe('X_CONFIG_INVALID');
      expect(error.cause).toContain('ai.mcp.path was removed in 25.0.0');
      expect(error.fix).toContain('defineAppMcp({ path');
      return;
    }
    expect.unreachable('a config writing ai.mcp.path was mounted');
  });
});

describe('mountAppMcp', () => {
  test('answers the same mount the pure half does, mounted or warned', async () => {
    const mounted = await mountAppMcp(
      await fixture('mount-mounted', {
        'app.config.ts': configWith('{ expose: true }'),
        'apps/web/mcp.ts': MCP_WITH_ROUTE,
      }),
    );
    expect(mounted.path).toBe('/mcp');
    expect(mounted.paths).toEqual(['/mcp']);
    expect(mounted.routes).toHaveLength(1);
    const warned = await mountAppMcp(
      await fixture('mount-warned', {
        'app.config.ts': configWith('{ expose: true }'),
      }),
    );
    expect(warned.routes).toEqual([]);
    expect(warned.warning?.code).toBe('X_MCP_APP_UNMOUNTED');
  });
});
