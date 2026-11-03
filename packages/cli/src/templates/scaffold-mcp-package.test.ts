// A new app's `POST /mcp` is mounted and refusing. Before this, `ai.mcp.expose: true` and an
// exposed `health` met a `defineAppMcp` with no `resolveToken`, so no route was built: 404 in dev
// and in the image, and every boot's first warning was X_MCP_APP_UNMOUNTED. What this pins is the
// wiring the mount reads (`app-mcp.ts`: `apps/<app>/mcp.ts`, export `mcp`, a route) and the tests
// the app is born with; the scaffold smoke boots the app and asks the socket.

import { describe, expect, test } from 'bun:test';
import { APP_MCP_EXPORT, APP_MCP_GLOB } from '../app-mcp';
import { names } from './naming';
import { mcpPackageFiles } from './scaffold-mcp-package';

const app = names('ledger-demo');

const source = (path: string): string => {
  const file = mcpPackageFiles(app).find((one) => one.path === path);
  if (file === undefined) return expect.unreachable(`x new writes no ${path}`);
  return typeof file.contents === 'string' ? file.contents : expect.unreachable(`${path} is bytes`);
};

describe('unit · the scaffold mounts its own MCP endpoint', () => {
  test('apps/web/mcp.ts is where the mount looks, exporting what it reads', () => {
    expect(new Bun.Glob(APP_MCP_GLOB).match('apps/web/mcp.ts')).toBe(true);
    const endpoint = source('apps/web/mcp.ts');
    expect(endpoint).toContain(`export const ${APP_MCP_EXPORT} = appMcp({`);
    // A route is only built with a resolver: without this line the file mounts nothing.
    expect(endpoint).toContain('resolveToken: resolveAgentToken');
    expect(endpoint).toContain("from '@ledger-demo/mcp'");
  });

  test('the package catalog takes the resolver and builds no route without one', () => {
    const index = source('packages/mcp/src/index.ts');
    expect(index).toContain('resolveToken');
    const unit = source('packages/mcp/src/index.test.ts');
    expect(unit).toContain('expect(appMcp().route).toBeUndefined()');
    expect(unit).toContain("expect(appMcp({ resolveToken: () => null }).route?.path).toBe('/mcp')");
  });

  test('the endpoint is born with its refusal under test: 401 with no token', () => {
    const test = source('apps/web/mcp.test.ts');
    expect(test).toContain('expect(response.status).toBe(401)');
    // The development token is a 401 too outside `x dev` — bun test is not development.
    expect(test).toContain(`Bearer \${DEV_AGENT_TOKEN_PREFIX}admin`);
  });

  test('the resolver is API keys everywhere and the dev token in development alone', () => {
    const resolver = source('apps/web/app/auth/agent-token.ts');
    expect(resolver).toContain('apiKeyResolver(');
    // Fails closed: a process naming no environment is production, never development.
    expect(resolver).toContain("fallback: 'production'");
    // And only from this machine, never from a browser: a page rebound to 127.0.0.1 sends Origin.
    expect(resolver).toContain('facts.origin === null');
    expect(resolver).toContain("peerAddressClass(facts.address) === 'loopback'");
    const test = source('apps/web/app/auth/agent-token.test.ts');
    expect(test).toContain("{ ULTIMATE_ENV: 'production' }");
    expect(test).toContain('toBeNull()');
  });
});
