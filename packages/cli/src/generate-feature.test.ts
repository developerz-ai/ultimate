// A `fix:` is the next command an agent runs, so these read what a refusal SUGGESTS: `--feature pst`
// offering `x g resource pst` invents a table, and the conflict that followed offered `--force` over
// the author's `entity.ts`.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API and no recursive delete.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { REQUIRED_BUN } from './app-root';
import { generateCommand } from './cmd-generate';
import type { CommandContext } from './command';
import { exec } from './exec';
import { assertFeatureExists, closestSlice, type FeatureUnknownError } from './generate-feature';
import { parseArgs } from './parse';
import { SPECS } from './registry';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const appWith = async (files: readonly string[]): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'x-generate-feature-'));
  roots.push(root);
  await Bun.write(join(root, 'app.config.ts'), 'export const config = {};\n');
  for (const file of files) await Bun.write(join(root, file), '');
  return root;
};

const refusal = (root: string, feature: string, slice: string): FeatureUnknownError => {
  try {
    assertFeatureExists(root, 'action', feature, slice, 'foo');
  } catch (error) {
    return error as FeatureUnknownError;
  }
  return expect.unreachable('a slice that is not there must be refused');
};

describe('X_FEATURE_UNKNOWN', () => {
  test('a typo is told the near slice, as the command it meant', async () => {
    const root = await appWith(['apps/web/app/post/entity.ts', 'apps/web/app/billing/policy.ts']);
    const error = refusal(root, 'pst', 'apps/web/app/pst');
    expect(error.fix).toBe('x g action foo --feature post');
    expect(error.cause).toContain('billing, post');
  });

  test('nothing near lists the slices, and only then names the generator that creates one', async () => {
    const root = await appWith(['apps/web/app/billing/entity.ts']);
    const error = refusal(root, 'shipments', 'apps/web/app/shipments');
    expect(error.fix).toBe('x g resource shipments');
    expect(error.cause).toContain('billing');
  });

  test('a page directory beside a slice is not a slice', async () => {
    const root = await appWith(['apps/web/app/post/entity.ts', 'apps/web/app/posts/page.tsx']);
    expect(refusal(root, 'pst', 'apps/web/app/pst').cause).not.toContain('posts');
  });

  test('no slice at all says so', async () => {
    const root = await appWith([]);
    expect(refusal(root, 'pst', 'apps/web/app/pst').cause).toContain('no slice exists');
  });

  test('the distance is capped at 2, and the closest wins', () => {
    expect(closestSlice('pst', ['post', 'pasta'])).toBe('post');
    expect(closestSlice('post', ['billing'])).toBeUndefined();
    expect(closestSlice('pst', ['pxxxt'])).toBeUndefined();
  });

  test('a hostile --feature never reaches the command', async () => {
    const root = await appWith(['apps/web/app/post/entity.ts']);
    expect(refusal(root, '$(id)', 'apps/web/app/x').fix).toBe("x g resource '$(id)'");
  });
});

describe('X_GENERATE_CONFLICT on a slice module', () => {
  const contextFor = (argv: readonly string[], cwd: string): CommandContext => ({
    args: parseArgs(argv, SPECS),
    cwd,
    runner: exec,
    env: {},
    bunVersion: REQUIRED_BUN,
  });

  test('x g resource over an existing slice leads with --feature, and offers no --force', async () => {
    const root = await appWith([]);
    const argv = ['g', 'resource', 'post'];
    // Its files are written whatever it says about a handle this fixture has no client for.
    await generateCommand.run(contextFor(argv, root));
    const second = await generateCommand.run(contextFor(argv, root));
    const onEntity = second.findings?.find((one) => one.at?.endsWith('post/entity.ts'));
    expect(onEntity?.code).toBe('X_GENERATE_CONFLICT');
    expect(onEntity?.fix).toStartWith('x g action post --feature post');
    expect(onEntity?.fix).toContain('x g query post --feature post');
    expect(onEntity?.fix).not.toContain('--force');
    const onPolicy = second.findings?.find((one) => one.at?.endsWith('post/policy.ts'));
    expect(onPolicy?.fix).not.toContain('--force');
  });
});
