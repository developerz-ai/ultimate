// The factory persister is put back at the file boundary to what the file's body inherited: a
// `factoryWorld()` (or any `usePersister`) with no `clearPersister()` handed its throwaway driver
// to every later file on a shared worker — `factory-persist.test.ts` "starts uninstalled" read it.

import { expect, test } from 'bun:test';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { runFixtures } from './registry-guard-run-fixture';

const PERSIST = join(import.meta.dir, 'factory-persist.ts');

const installer = (name: string): string => `import { expect, test } from 'bun:test';
import { persisterInstalled, usePersister } from '${PERSIST}';

test('${name} starts with no persister and leaves one installed', () => {
  expect(persisterInstalled()).toBe(false);
  usePersister({ insert: async (_entity, row) => row });
});
`;

test('a persister one file left installed is gone before the next file starts', async () => {
  const { output, exitCode } = await runFixtures({
    'one.test.ts': installer('one'),
    'two.test.ts': installer('two'),
  });
  expect(output).toContain('2 pass');
  expect(exitCode).toBe(0);
}, 30_000);
