// The two sides of an MCP-vs-shell parity check on the reference app: `x <args>` as a shell runs
// it, and one `tools/call` over `x mcp serve`'s stdio. Shared by the `mcp-host*.parity` files, one
// per tool, so test workers run them side by side.

import { expect } from 'bun:test';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';

const REPO = join(import.meta.dir, '..', '..', '..');
const APP = join(REPO, 'examples', 'dummy');
const BIN = join(REPO, 'packages', 'cli', 'src', 'bin.ts');
/** One contract file that seeds the app's development data unless its process is a test one. */
export const PARITY_FILE = 'packages/mcp/src/tenant.contract.test.ts';

/**
 * One child's ceiling, under the 180 s test timeout: a side measures ~6 s alone and 28 s in the
 * loaded gate (2026-11-16). A hung `x` is killed and fails its parse, never holds the worker.
 */
const CHILD_MS = 170_000;

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

/** `x <args> --json` in the reference app, as a shell runs it. */
export async function shell(args: readonly string[]): Promise<{ ok: boolean; steps: unknown }> {
  const proc = Bun.spawn(['bun', BIN, ...args, '--json'], {
    cwd: APP,
    env: shellEnv(),
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: CHILD_MS,
  });
  const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  const parsed = JSON.parse(stdout) as { ok: boolean; steps?: unknown };
  return { ok: parsed.ok, steps: parsed.steps };
}

/** One `tools/call` over `x mcp serve`'s stdio, the transport an agent's client speaks. */
export async function mcpCall(
  name: string,
  args: Readonly<Record<string, unknown>>,
): Promise<{ isError: boolean; json: unknown }> {
  const proc = Bun.spawn(['bun', BIN, 'mcp', 'serve'], {
    cwd: APP,
    env: shellEnv(),
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: CHILD_MS,
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
