// The dev MCP server and the shell answer one question the same way: `tests.run` beside `x test`
// here, `verify.run` beside `x verify` in `mcp-host-verify.parity.test.ts` — both spawned as real
// `x` processes on the reference app with the environment a shell has. `x mcp serve` declares
// `ULTIMATE_ENV=development` for itself, and its test children inherited it — every seed ran as
// development, and green files answered red. A file per tool, so test workers run them side by side.

import { expect, test } from 'bun:test';
import { mcpCall, PARITY_FILE, shell } from './mcp-host-parity-fixture';

test('tests.run answers what x test answers for the same file', async () => {
  const [cli, mcp] = await Promise.all([
    shell(['test', '--filter', PARITY_FILE]),
    mcpCall('tests.run', { filter: PARITY_FILE }),
  ]);
  expect(cli.ok).toBe(true);
  expect({ ok: !mcp.isError, failed: (mcp.json as { failed: number }).failed }).toEqual({
    ok: cli.ok,
    failed: 0,
  });
}, 180_000);
