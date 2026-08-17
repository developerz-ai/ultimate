// contract — the catalog, over the app's real boot. `include: 'exposed'` reads a registry, so the
// only honest proof is to fill that registry the way the process does: `loadApp` scans `apps/*`
// exactly as `runRole()` does.
//
// A unit test cannot prove this. The previous one asserted `mcp.tools.length > 0` against a
// module-scope snapshot that its own file had force-fed by importing an action out of `apps/web` —
// green, and true of nothing the server does.

import { resolve } from 'node:path';
import { loadApp } from '@ultimat3/cli';
import { beforeAll, contractTest, expect } from '@ultimat3/testing';
import { appMcp } from './index';

const ROOT = resolve(import.meta.dir, '../../..');

beforeAll(async () => {
  await loadApp(ROOT);
  // `loadApp` walks this app's whole module graph — ~2.7s alone, and the four contract files
  // that do it run while every other suite competes for the same cores, so the 5000ms bun
  // gives a hook is a coin flip rather than a budget. Booting the app IS the fixture here,
  // so the timeout is what moves. Raised across all four together: they share one cost, and
  // raising the one seen failing only relocates the failure to whichever shard the others
  // land in.
}, 30_000);

contractTest('the app exposes its actions as MCP tools, from the registry its boot filled', () => {
  const tools = appMcp().tools;
  expect(tools.length).toBeGreaterThan(0);
  // `health` declares `mcp: { expose: true }` in apps/web/api/health.ts — the catalog is derived
  // from that declaration, never from a list kept here.
  expect(tools.map((tool) => tool.name)).toContain('health');
});

contractTest('exposure is opt-in — an action that declared expose:false is not a tool', () => {
  // `createSession` writes a session cookie and says `mcp: { expose: false }`. If silence or a
  // literal `false` ever exposed a tool again, every agent would gain a way to mint a session.
  expect(appMcp().tools.map((tool) => tool.name)).not.toContain('create_session');
});

contractTest(
  'every projected tool describes itself — an agent picks a tool by its description',
  () => {
    // Asserted on the value, not its length: a failure then prints the empty description rather
    // than "0 > 0".
    for (const tool of appMcp().tools) expect(tool.description).not.toBe('');
  },
);
