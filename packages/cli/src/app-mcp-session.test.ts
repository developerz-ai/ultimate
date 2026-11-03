// `POST /mcp` through the whole http pipeline, beside an app authenticator that turns a session
// cookie into a user. The route names its own authenticator — nobody — so a cookie authenticates
// nothing there: the bearer `resolveToken` reads is the only credential. Before, the cookie made the
// request a user's, and CSRF then refused a token-less MCP client with 403 where it is owed the 401
// (and its `WWW-Authenticate` challenge). The other half is the security claim: no cookie, with or
// without browser evidence, reaches a tool.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no tmpdir(); a fixture lives outside the checkout, where a parallel worker
// globbing the tree cannot meet it half-deleted.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; the fixture and the mcp source are joined to paths.
import { join } from 'node:path';
import { userActor } from '@ultimat3/core';
import { defineHttpConfig, httpPipeline, httpRouter } from '@ultimat3/http';
import { clearPermissions } from '@ultimat3/policy';
import { appMcpMount } from './app-mcp';

const ROOT = join(tmpdir(), `x-app-mcp-session-${process.pid}`);
const CORE = join(import.meta.dir, '../../core/src/index.ts');
const MCP = join(import.meta.dir, '../../mcp/src/index.ts');

/** How many times the one tool ran — the thing a cookie must never cause. */
const calls = (): number => (globalThis as { __mcpSessionCalls?: number }).__mcpSessionCalls ?? 0;

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});
// The tool's `can()` names a permission nothing declares: legal only while the set is empty.
beforeAll(clearPermissions);

const mounted = async () => {
  await Bun.write(
    join(ROOT, 'app.config.ts'),
    `export const config = { name: 'demo', ai: { mcp: { expose: true } } };\n`,
  );
  await Bun.write(
    join(ROOT, 'apps/web/mcp.ts'),
    `import { agentActor } from '${CORE}';
import { defineAppMcp, t } from '${MCP}';
export const mcp = defineAppMcp({
  name: 'session-check',
  tools: {
    secret: {
      description: 'secret, read-only.',
      input: t.object({}),
      policy: 'x:read',
      destructive: false,
      handle: () => {
        globalThis.__mcpSessionCalls = (globalThis.__mcpSessionCalls ?? 0) + 1;
        return { ok: true };
      },
    },
  },
  resolveToken: (token) =>
    token === 'right'
      ? { actor: agentActor({ id: 'a1', orgId: 'o1', roles: [], permissions: ['x:read'] }), scopes: new Set() }
      : null,
});
`,
  );
  const mount = await appMcpMount(ROOT);
  let sessionsRead = 0;
  return {
    sessionsRead: () => sessionsRead,
    pipeline: httpPipeline({
      table: httpRouter(mount.routes),
      config: defineHttpConfig({ rateLimit: { scope: 'process' }, dev: false }),
      // The app's authenticator: a cookie `sid=admin` is an admin who may do anything.
      hooks: {
        authenticate: (request) => {
          sessionsRead += 1;
          return request.header('cookie')?.includes('sid=admin')
            ? userActor({ id: 'u1', orgId: 'o1', roles: ['admin'], permissions: ['x:read'] })
            : null;
        },
      },
    }),
  };
};

const call = (headers: Record<string, string>) =>
  new Request('http://localhost/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'secret', arguments: {} },
    }),
  });

describe('unit · a session cookie authenticates nothing on POST /mcp', () => {
  test('a session cookie and no token is 401 — the bearer challenge, never CSRF 403', async () => {
    const { pipeline, sessionsRead } = await mounted();
    const before = calls();
    const response = await pipeline.handle(call({ cookie: 'sid=admin' }), { role: 'web' });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toStartWith('Bearer');
    expect(((await response.json()) as { code: string }).code).toBe('X_MCP_PROTOCOL');
    // The app's authenticator is never asked: the route named its own, and it answers nobody.
    expect(sessionsRead()).toBe(0);
    expect(calls()).toBe(before);
  });

  test('a cookie with browser evidence, same-site or cross-site, reaches no tool', async () => {
    const { pipeline } = await mounted();
    const before = calls();
    for (const evidence of [
      { origin: 'https://evil.test' },
      { origin: 'http://localhost', 'sec-fetch-site': 'same-origin' },
      { 'sec-fetch-site': 'cross-site' },
    ]) {
      const response = await pipeline.handle(call({ cookie: 'sid=admin', ...evidence }), {
        role: 'web',
      });
      // 401 or CSRF's 403 — refused either way, and never by running the tool.
      expect(response.status === 401 || response.status === 403).toBe(true);
    }
    expect(calls()).toBe(before);
  });

  test('the token alone is what reaches the tool — the control that makes the rest mean something', async () => {
    const { pipeline } = await mounted();
    const before = calls();
    const wrong = await pipeline.handle(call({ authorization: 'Bearer wrong' }), { role: 'web' });
    expect(wrong.status).toBe(401);
    const right = await pipeline.handle(call({ authorization: 'Bearer right' }), { role: 'web' });
    expect(right.status).toBe(200);
    expect(calls()).toBe(before + 1);
  });
});
