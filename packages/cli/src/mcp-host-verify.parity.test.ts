// `verify.run` beside `x verify`, both spawned as real `x` processes on the reference app with the
// environment a shell has. `tests.run`'s twin is `mcp-host.parity.test.ts`; a file each, so test
// workers run the two side by side.

import { expect, test } from 'bun:test';
import { mcpCall, shell } from './mcp-host-parity-fixture';

test('verify.run answers what x verify answers for the same steps', async () => {
  const [cli, mcp] = await Promise.all([
    shell(['verify', '--only', 'live']),
    mcpCall('verify.run', { only: ['live'] }),
  ]);
  expect(cli.ok).toBe(true);
  const steps = (cli.steps as readonly { name: string; ok: boolean }[]).map(({ name, ok }) => ({
    name,
    ok,
  }));
  const mcpSteps = (mcp.json as { steps: readonly { name: string; ok: boolean }[] }).steps.map(
    ({ name, ok }) => ({ name, ok }),
  );
  expect({ ok: !mcp.isError, steps: mcpSteps }).toEqual({ ok: cli.ok, steps });
}, 180_000);
