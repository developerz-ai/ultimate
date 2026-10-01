// `loadSpeculation` reads the app's config module structurally, so what it finds may never have
// passed `defineConfig`. Pinned, failures first: it refuses what `defineConfig` refuses — through
// core's one validator — and never coerces a wrong value into a rule the app did not write.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises'; // why: Bun has no mkdtemp and no recursive remove.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { ConfigInvalidError } from '@ultimat3/core';
import { loadSpeculation } from './page-speculation';

let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ultimate-speculation-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// A fresh path per test: `import()` caches by resolved specifier for the life of the process.
const writeConfig = (speculation: string) =>
  Bun.write(
    join(root, 'app.config.ts'),
    `export const config = { navigation: { speculation: ${speculation} } };\n`,
  );

const refusal = async (): Promise<unknown> => {
  try {
    await loadSpeculation(root);
  } catch (error) {
    return error;
  }
  return undefined;
};

describe('unit · loadSpeculation refuses, never coerces', () => {
  test.each([
    [
      "an eagerness not offered is not served as 'moderate'",
      "{ prefetch: 'eager' }",
      'prefetch must be',
    ],
    ['a non-string pattern is not dropped', "{ exclude: ['/a/*', 7] }", 'exclude contains'],
    [
      'a pattern that is not a path is not kept',
      "{ exclude: ['https://other.test/*'] }",
      'exclude contains',
    ],
    ['a non-list exclude is not emptied', "{ exclude: '/a/*' }", 'exclude must be a list'],
    ['a non-object is not run at the default', "'off'", 'must be an object'],
  ])('%s', async (_name, speculation, cause) => {
    await writeConfig(speculation);
    const error = await refusal();
    expect(error).toBeInstanceOf(ConfigInvalidError);
    expect((error as ConfigInvalidError).code).toBe('X_CONFIG_INVALID');
    expect((error as ConfigInvalidError).cause).toContain(
      `navigation.speculation${speculation === "'off'" ? ' ' : '.'}${cause}`,
    );
  });

  test('no file is the default', async () => {
    expect(await loadSpeculation(root)).toEqual({ prefetch: 'moderate', exclude: [] });
  });

  test('a config that says nothing is the default', async () => {
    await Bun.write(join(root, 'app.config.ts'), 'export const config = { name: "x" };\n');
    expect(await loadSpeculation(root)).toEqual({ prefetch: 'moderate', exclude: [] });
  });

  test('a valid block is read as written, a partial one filled', async () => {
    await writeConfig("{ prefetch: 'conservative', exclude: ['/blog/*'] }");
    expect(await loadSpeculation(root)).toEqual({ prefetch: 'conservative', exclude: ['/blog/*'] });
  });

  test('`false` stays off', async () => {
    await writeConfig('{ prefetch: false }');
    expect(await loadSpeculation(root)).toEqual({ prefetch: false, exclude: [] });
  });
});
