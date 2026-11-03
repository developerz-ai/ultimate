// The endpoint's files, each paired with the test the app's coverage floor needs beside it: a
// module no unit test loads counts at 0% in the app's own `unit` step, red on the first gate.

import { describe, expect, test } from 'bun:test';
import { names } from './naming';
import { mcpEndpointFiles } from './scaffold-mcp-endpoint';

const files = mcpEndpointFiles(names('ledger-demo'));
const paths = files.map((file) => file.path);

describe('unit · the endpoint x new writes', () => {
  test('the mount file and the resolver, each with its test beside it', () => {
    expect(paths).toEqual([
      'apps/web/mcp.ts',
      'apps/web/mcp.test.ts',
      'apps/web/app/auth/agent-token.ts',
      'apps/web/app/auth/agent-token.test.ts',
    ]);
    for (const source of paths.filter((path) => !path.endsWith('.test.ts'))) {
      expect(paths).toContain(source.replace(/\.ts$/, '.test.ts'));
    }
  });

  test('the endpoint names its own package, so each app mounts its own catalog', () => {
    const endpoint = String(files[0]?.contents);
    expect(endpoint).toContain("import { appMcp } from '@ledger-demo/mcp';");
    expect(endpoint).toContain('X_MCP_APP_UNMOUNTED');
  });
});
