// `linkWorkspace`, the run-time half of a contract scaffold: after it, the app's `node_modules`
// resolves every root dependency and every `@ultimat3/*` package to THIS checkout, by name — the
// one thing `generate-sign-in.contract.test.ts` needs before it can `bun test` the generated code.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive, no realpath and no recursive delete.
import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { linkWorkspace } from './generate-sign-in-fixture';
import { workspaceRoot } from './scaffold-typecheck-fixture';

const dir = mkdtempSync(join(tmpdir(), 'x-link-workspace-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('linkWorkspace', () => {
  test('every root dependency and every @ultimat3 package resolves to the checkout', async () => {
    await linkWorkspace(dir);
    const root = workspaceRoot();

    const modules = join(dir, 'node_modules');
    for (const entry of readdirSync(join(root, 'node_modules'))) {
      expect(realpathSync(join(modules, entry))).toBe(
        realpathSync(join(root, 'node_modules', entry)),
      );
    }
    // By the manifest's NAME, not the directory's: the scope holds exactly the publishable set.
    const linked = readdirSync(join(modules, '@ultimat3')).sort();
    expect(linked).toContain('core');
    expect(linked).toContain('cli');
    expect(realpathSync(join(modules, '@ultimat3', 'core'))).toBe(
      realpathSync(join(root, 'packages', 'core')),
    );
    const core: unknown = await Bun.file(join(modules, '@ultimat3', 'core', 'package.json')).json();
    expect(core).toMatchObject({ name: '@ultimat3/core' });
  });
});
