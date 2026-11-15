// What the guard restores of the tables `declaration-boundary.ts` lists, across files in one
// process: a channel, a served recipe and a declared remote server a file's body added are gone
// before the next file evaluates. Each pair is identical but for a name, so either order.

import { describe, expect, test } from 'bun:test';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { runFixtures } from './registry-guard-run-fixture';

const PACKAGES = join(import.meta.dir, '..', '..');
const REALTIME = join(PACKAGES, 'realtime', 'src', 'index.ts');
const RECIPES = join(PACKAGES, 'mcp', 'src', 'recipe-links.ts');
const REMOTE = join(PACKAGES, 'mcp', 'src', 'remote-tools.ts');

/** Both files declare the SAME channel name: a second declaration in one process is refused. */
const channelDeclarer = (name: string): string => `import { expect, test } from 'bun:test';
import { allow } from '${join(PACKAGES, 'policy', 'src', 'index.ts')}';
import { channel, registeredChannels } from '${REALTIME}';

channel('boundary-shared', { params: [], catchUp: { name: '${name}Read' }, policy: allow('public') });

test('${name} declares the shared channel name once, as the only file that has', () => {
  expect(registeredChannels().map((each) => each.name)).toContain('boundary-shared');
});
`;

const mcpDeclarer = (name: string): string => `import { expect, test } from 'bun:test';
import { noteServedRecipes, servedRecipes } from '${RECIPES}';
import { declaredMcpServers, restoreDeclaredMcpServers } from '${REMOTE}';

noteServedRecipes(['recipe-${name}']);
restoreDeclaredMcpServers(new Map([...declaredMcpServers(), ['server-${name}', { name: 'server-${name}' }]]));

test('${name} sees its own recipe and server, and no other file’s', () => {
  expect([...servedRecipes()]).toEqual(['recipe-${name}']);
  expect([...declaredMcpServers().keys()]).toEqual(['server-${name}']);
});
`;

const HOOKS = join(PACKAGES, 'http', 'src', 'hooks.ts');

const authenticatorSetter = (name: string): string => `import { expect, test } from 'bun:test';
import { configureAuthenticator, configuredAuthenticator } from '${HOOKS}';

test('${name} starts anonymous and leaves an authenticator configured', () => {
  expect(configuredAuthenticator()).toBeUndefined();
  configureAuthenticator(async () => null);
});
`;

describe('module-scope declaration tables, in one process', () => {
  test('an authenticator one file configured is gone before the next file starts', async () => {
    const { output, exitCode } = await runFixtures({
      'one.test.ts': authenticatorSetter('one'),
      'two.test.ts': authenticatorSetter('two'),
    });
    expect(output).toContain('2 pass');
    expect(exitCode).toBe(0);
  }, 30_000);

  test('a channel one file’s body declared is gone before the next declares the name', async () => {
    const { output, exitCode } = await runFixtures({
      'one.test.ts': channelDeclarer('one'),
      'two.test.ts': channelDeclarer('two'),
    });
    expect(output).not.toContain('X_CHANNEL_DECLARATION_INVALID');
    expect(output).toContain('2 pass');
    expect(exitCode).toBe(0);
  }, 30_000);

  test('a served recipe and a declared remote server end with the file that added them', async () => {
    const { output, exitCode } = await runFixtures({
      'one.test.ts': mcpDeclarer('one'),
      'two.test.ts': mcpDeclarer('two'),
    });
    expect(output).toContain('2 pass');
    expect(exitCode).toBe(0);
  }, 30_000);
});
