// The app exposes its actions as MCP tools, and each tool carries the action's own policy. The
// catalog reads a registry, so the honest proof fills it the way the process does: `loadApp` scans
// `apps/*` exactly as `runRole()` does. Booting the app is the fixture, so the timeout moves.
import { resolve } from 'node:path';
import { loadApp } from '@ultimat3/cli';
import { beforeAll, contractTest, expect } from '@ultimat3/testing';
import { appMcp } from './index';

beforeAll(async () => {
  await loadApp(resolve(import.meta.dir, '../../..'));
}, 30_000);

contractTest('the app exposes its actions as MCP tools', () => {
  const tools = appMcp().tools;
  expect(tools.length).toBeGreaterThan(0);
  // Every projected tool must describe itself: an agent picks a tool by its description. Assert
  // on the value, not its length — a failure then prints the empty description, not "0 > 0".
  for (const tool of tools) expect(tool.description).not.toBe('');
});
