// The dev MCP server and the shell answer one question the same way: `tests.run` beside `x test`,
// `verify.run` beside `x verify`, both spawned as real `x` processes on the reference app with the
// environment a shell has. `x mcp serve` declares `ULTIMATE_ENV=development` for itself, and its
// test children inherited it — every seed ran as development, and green files answered red.

import { expect, test } from 'bun:test';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';

const REPO = join(import.meta.dir, '..', '..', '..');
const APP = join(REPO, 'examples', 'dummy');
const BIN = join(REPO, 'packages', 'cli', 'src', 'bin.ts');
// One contract file that seeds the app's development data unless its process is a test one.
const FILE = 'packages/mcp/src/tenant.contract.test.ts';

/**
 * A shell's environment: this process's, less what `bun test` itself set for it. `NODE_ENV=test`
 * would hide the defect (`x mcp serve` declares nothing when NODE_ENV is set), and a worker id
 * would tell the app's own `bun test` it is a worker of this run.
 */
function shellEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(Bun.env)) {
    if (value === undefined || key === 'NODE_ENV' || key === 'ULTIMATE_ENV') continue;
    if (key.startsWith('BUN_TEST')) continue;
    env[key] = value;
  }
  return env;
}

async function shell(args: readonly string[]): Promise<{ ok: boolean; steps: unknown }> {
  const proc = Bun.spawn(['bun', BIN, ...args, '--json'], {
    cwd: APP,
    env: shellEnv(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  const parsed = JSON.parse(stdout) as { ok: boolean; steps?: unknown };
  return { ok: parsed.ok, steps: parsed.steps };
}

/** One `tools/call` over `x mcp serve`'s stdio, the transport an agent's client speaks. */
async function mcpCall(
  name: string,
  args: Readonly<Record<string, unknown>>,
): Promise<{ isError: boolean; json: unknown }> {
  const proc = Bun.spawn(['bun', BIN, 'mcp', 'serve'], {
    cwd: APP,
    env: shellEnv(),
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const request = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  };
  proc.stdin.write(`${JSON.stringify(request)}\n`);
  proc.stdin.flush();
  const decoder = new TextDecoder();
  let buffer = '';
  let response: { result?: { content?: { text?: string }[]; isError?: boolean } } | undefined;
  for await (const chunk of proc.stdout) {
    buffer += decoder.decode(chunk, { stream: true });
    const line = buffer.split('\n').find((entry) => entry.includes('"id":1'));
    if (line !== undefined) {
      response = JSON.parse(line) as typeof response;
      break;
    }
  }
  proc.stdin.end();
  const [stderr] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  // A server that died before answering says why on stderr; a JSON parse error would not.
  if (response === undefined) expect.unreachable(`x mcp serve answered nothing: ${stderr}`);
  const text = response?.result?.content?.[0]?.text ?? '';
  return { isError: response?.result?.isError === true, json: JSON.parse(text) };
}

test('tests.run answers what x test answers for the same file', async () => {
  const [cli, mcp] = await Promise.all([
    shell(['test', '--filter', FILE]),
    mcpCall('tests.run', { filter: FILE }),
  ]);
  expect(cli.ok).toBe(true);
  expect({ ok: !mcp.isError, failed: (mcp.json as { failed: number }).failed }).toEqual({
    ok: cli.ok,
    failed: 0,
  });
}, 180_000);

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
