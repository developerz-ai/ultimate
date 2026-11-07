// The admin surface's endpoint `x new` writes: `apps/admin/mcp.ts`, the file the mount reads for
// that app directory, serving the admin catalog AND the app's exposed tools at `/admin/mcp`, built
// at module scope there (after the scan registered every primitive), with its test beside it.

import { describe, expect, test } from 'bun:test';
import { names } from './naming';
import { mcpAdminFiles } from './scaffold-mcp-admin';
import { mcpPackageFiles } from './scaffold-mcp-package';

const app = names('ledger-demo');
const files = mcpAdminFiles(app);
const source = String(files.find((file) => file.path === 'apps/admin/mcp.ts')?.contents);

describe('unit · the admin endpoint x new writes', () => {
  test('the mount file and its test, written with the rest of the MCP files', () => {
    expect(files.map((file) => file.path)).toEqual(['apps/admin/mcp.ts', 'apps/admin/mcp.test.ts']);
    const written = mcpPackageFiles(app).map((file) => file.path);
    expect(written).toContain('apps/admin/mcp.ts');
    expect(written).toContain('apps/admin/mcp.test.ts');
  });

  test("one adminMcp at module scope: its own path, the app's tools, the app's token resolver", () => {
    expect(source).toContain('export const mcp = adminMcp({');
    expect(source).toContain("path: '/admin/mcp'");
    expect(source).toContain("include: 'exposed'");
    expect(source).toContain("resolveAgentToken } from '@ledger-demo/web/app/auth/agent-token';");
    // The request facts ride to the resolver: the development token is decided on them.
    expect(source).toContain('resolveAgentToken(token, facts)');
    // Built here, never in apps/admin/app/: the mount refuses an early catalog.
    expect(source).toContain('X_MCP_INCLUDE_EARLY');
  });

  test('its test pins the route mounted and refusing', () => {
    const test = String(files.find((file) => file.path === 'apps/admin/mcp.test.ts')?.contents);
    expect(test).toContain("expect(route.path).toBe('/admin/mcp');");
    expect(test).toContain('expect(response.status).toBe(401);');
  });
});
