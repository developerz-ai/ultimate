/**
 * unit — `./tools.ts` evaluated ALONE, against a fresh action registry: importing it must be
 * correct with nothing else booted, which a module-scope server was not — its gate refused at
 * import whenever `apps/web/api` had not registered `publishPost` first (root-run import order).
 * Building it with nothing registered is still refused, naming the gated tool: the gate never
 * builds a server that would run `publishPost` unconfirmed. In a child: this suite's process holds
 * the registry its neighbours read, and emptying it here took their gates with it.
 */

import { expect, test } from '@ultimat3/testing';

const TOOLS = `${import.meta.dir}/tools.ts`;
const PROBE = `
const { postlyMcp } = await import(${JSON.stringify(TOOLS)});
console.log(typeof postlyMcp);
try {
  postlyMcp();
  console.log('built');
} catch (refusal) {
  console.log(String(refusal.code), String(refusal.cause));
}
`;

test('tools.ts imports cleanly into an empty registry, and the server is built only on call', async () => {
  const child = Bun.spawn([process.execPath, '-e', PROBE], {
    cwd: import.meta.dir,
    env: { ...Bun.env, NODE_ENV: 'test' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect([code, err]).toEqual([0, '']);
  expect(out).toMatch(/^function\nX_MCP_CONFIRMATION_TOOL_UNKNOWN [\s\S]*publishPost/);
});
