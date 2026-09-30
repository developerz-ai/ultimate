// Several MCP endpoints from one `apps/<app>/mcp.ts` — one per population. Real `defineAppMcp`
// values (imported by absolute path: a fixture outside the checkout has no node_modules), driven
// over the mounted route handlers, so "the staff catalog never reaches a customer" is asserted on
// the wire and not on a list. One fixture directory PER CASE: `import()` caches by path.
import { afterAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no tmpdir(); a fixture lives outside the checkout, where a parallel worker
// globbing the tree cannot meet it half-deleted.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; fixtures and the mcp source are joined to paths.
import { join } from 'node:path';
import type { Route, UltimateRequest } from '@ultimat3/http';
import { appMcpMount } from './app-mcp';

const FIXTURES = join(tmpdir(), `x-app-mcp-endpoints-${process.pid}`);
const MCP_SOURCE = join(import.meta.dir, '../../mcp/src/index.ts');

afterAll(async () => {
  await rm(FIXTURES, { recursive: true, force: true });
});

const fixture = async (name: string, mcpTs: string, path = '/mcp'): Promise<string> => {
  const root = join(FIXTURES, name);
  await rm(root, { recursive: true, force: true });
  await Bun.write(
    join(root, 'app.config.ts'),
    `export const config = { ai: { mcp: { expose: true, path: '${path}' } } };\n`,
  );
  await Bun.write(join(root, 'apps/web/mcp.ts'), mcpTs);
  return root;
};

/** One endpoint: a single read-only tool named `tool`, and an agent for any bearer token. */
const endpoint = (tool: string, extra = ''): string => `defineAppMcp({
  name: '${tool}-server',
  tools: {
    ${tool}: {
      description: '${tool}, read-only.',
      input: t.object({}),
      policy: 'x:read',
      destructive: false,
      handle: () => ({ from: '${tool}' }),
    },
  },
  resolveToken: () => ({ actor: agentActor({ id: 'a1', orgId: 'o1', roles: [] }), scopes: new Set() }),
  ${extra}
})`;

const module = (body: string): string =>
  `import { agentActor } from '${join(import.meta.dir, '../../core/src/index.ts')}';
import { defineAppMcp, t } from '${MCP_SOURCE}';
export const mcp = ${body};
`;

const routeAt = (routes: readonly Route[], method: string, path: string): Route => {
  const route = routes.find((r) => r.method === method && r.path === path);
  if (route === undefined) return expect.unreachable(`no ${method} ${path} was mounted`);
  return route;
};

const drive = async (route: Route, body?: unknown, bearer = true): Promise<Response> => {
  const raw = new Request(`https://app.test${route.path}`, {
    method: route.method,
    headers: {
      'content-type': 'application/json',
      ...(bearer ? { authorization: 'Bearer t' } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const ctx = { url: new URL(raw.url), https: true } as never;
  return route.handler({ raw } as unknown as UltimateRequest, ctx);
};

const toolNames = async (route: Route): Promise<readonly string[]> => {
  const response = await drive(route, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const payload = (await response.json()) as { result: { tools: { name: string }[] } };
  return payload.result.tools.map((tool) => tool.name);
};

const refusal = async (root: string): Promise<{ code: string; cause: string; fix: string }> => {
  try {
    await appMcpMount(root);
  } catch (thrown) {
    return thrown as { code: string; cause: string; fix: string };
  }
  return expect.unreachable('two endpoints on one path were mounted');
};

describe('several endpoints — refusals first', () => {
  test('a second endpoint with no path defaults to /mcp and is refused beside the default', async () => {
    const root = await fixture(
      'dup-default',
      module(`[${endpoint('customer')}, ${endpoint('staff')}]`),
    );
    const thrown = await refusal(root);
    expect(thrown.code).toBe('X_MCP_PATH_DUPLICATE');
    expect(thrown.cause).toContain('POST /mcp');
    expect(thrown.cause).toContain('#0 and #1');
    expect(thrown.fix).toContain("path: '/mcp/");
  });

  test('two secondary endpoints naming one path are refused, naming both', async () => {
    const root = await fixture(
      'dup-explicit',
      module(
        `[${endpoint('customer')}, ${endpoint('staff', "path: '/mcp/admin',")}, ${endpoint('affiliate', "path: '/mcp/admin',")}]`,
      ),
    );
    const thrown = await refusal(root);
    expect(thrown.code).toBe('X_MCP_PATH_DUPLICATE');
    expect(thrown.cause).toContain('#1 and #2');
    expect(thrown.cause).toContain('POST /mcp/admin');
  });

  test("a second endpoint's tools are invisible — and uncallable — from the first", async () => {
    const root = await fixture(
      'isolated',
      module(`[${endpoint('customer')}, ${endpoint('staff', "path: '/mcp/admin',")}]`),
    );
    const mount = await appMcpMount(root);
    expect(mount.path).toBe('/mcp');
    expect(mount.paths).toEqual(['/mcp', '/mcp/admin']);
    const customers = routeAt(mount.routes, 'POST', '/mcp');
    const staff = routeAt(mount.routes, 'POST', '/mcp/admin');
    expect(await toolNames(customers)).toEqual(['customer']);
    expect(await toolNames(staff)).toEqual(['staff']);
    const call = await drive(customers, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'staff', arguments: {} },
    });
    const payload = (await call.json()) as { error?: { code: number } };
    expect(payload.error?.code).toBe(-32601);
    // Each endpoint is its own route name, so logs and metrics can tell the populations apart.
    expect(customers.meta.name).toBe('mcp');
    expect(staff.meta.name).toBe('mcp:/mcp/admin');
  });

  test('an endpoint built without resolveToken is the warning; the others still mount', async () => {
    const root = await fixture(
      'one-unroutable',
      module(
        `[${endpoint('customer')}, defineAppMcp({ path: '/mcp/admin' }), ${endpoint('affiliate', "path: '/mcp/afiliados',")}]`,
      ),
    );
    const mount = await appMcpMount(root);
    expect(mount.paths).toEqual(['/mcp', '/mcp/afiliados']);
    expect(mount.warning?.code).toBe('X_MCP_APP_UNMOUNTED');
    expect(mount.warning?.reason).toBe('no-route');
    expect(mount.warning?.cause).toContain('mcp[1]');
    expect(mount.warning?.fix).toContain('mcp[1]');
  });

  test('endpoint #0 mounts at ai.mcp.path, as a single export does; the others at their own', async () => {
    const root = await fixture(
      'default-path',
      module(`[${endpoint('customer')}, ${endpoint('staff', "path: '/mcp/admin',")}]`),
      '/agent',
    );
    const mount = await appMcpMount(root);
    expect(mount.routes.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /agent',
      'POST /mcp/admin',
    ]);
  });
});

describe('several endpoints — RFC 9728 metadata per path', () => {
  const oauth = (scopes: string): string =>
    `oauth: { authorizationServers: ['https://app.test'] }, scopes: ${scopes},`;

  const threeEndpoints = module(`[
  ${endpoint('customer', oauth("{ 'casos:read': ['customer'] }"))},
  ${endpoint('staff', `path: '/mcp/admin', ${oauth("{ 'admin:read': ['staff'] }")}`)},
  ${endpoint('affiliate', `path: '/mcp/afiliados', ${oauth("{ 'afiliados:read': ['affiliate'] }")}`)},
]`);

  test('each endpoint has its own path-inserted document; the root one stays the default', async () => {
    const mount = await appMcpMount(await fixture('metadata', threeEndpoints));
    expect(mount.routes.filter((r) => r.method === 'GET').map((r) => r.path)).toEqual([
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp/admin',
      '/.well-known/oauth-protected-resource/mcp/afiliados',
    ]);
    const documentAt = async (path: string): Promise<Record<string, unknown>> =>
      (await drive(routeAt(mount.routes, 'GET', path))).json() as Promise<Record<string, unknown>>;
    expect(await documentAt('/.well-known/oauth-protected-resource')).toMatchObject({
      resource: 'https://app.test/mcp',
      scopes_supported: ['casos:read'],
    });
    expect(await documentAt('/.well-known/oauth-protected-resource/mcp/admin')).toMatchObject({
      resource: 'https://app.test/mcp/admin',
      scopes_supported: ['admin:read'],
    });
    expect(await documentAt('/.well-known/oauth-protected-resource/mcp/afiliados')).toMatchObject({
      resource: 'https://app.test/mcp/afiliados',
      scopes_supported: ['afiliados:read'],
    });
  });

  test("each endpoint's 401 names its own metadata document and its own scopes", async () => {
    const mount = await appMcpMount(await fixture('challenge', threeEndpoints));
    const challenge = async (path: string): Promise<string> => {
      const response = await drive(routeAt(mount.routes, 'POST', path), undefined, false);
      expect(response.status).toBe(401);
      return response.headers.get('www-authenticate') ?? '';
    };
    const admin = await challenge('/mcp/admin');
    expect(admin).toContain(
      'resource_metadata="https://app.test/.well-known/oauth-protected-resource/mcp/admin"',
    );
    expect(admin).toContain('scope="admin:read"');
    expect(await challenge('/mcp')).toContain(
      'resource_metadata="https://app.test/.well-known/oauth-protected-resource/mcp"',
    );
  });
});
