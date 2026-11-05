// A scaffolded app that can RUN against this checkout: its `node_modules` holds the workspace's own
// root entries and every `@ultimat3/*` package linked by name, so `bun test` finds the app's
// preload and a boot finds the framework. `typecheckScaffold` needs none of this — `tsc` resolves
// through a paths overlay — but Bun at run time resolves through `node_modules` alone.

// why: Bun has no API for a directory listing with types, a symlink, or a recursive mkdir.
import { mkdirSync, readdirSync, symlinkSync } from 'node:fs';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { DIR_LINK, workspaceRoot } from './scaffold-typecheck-fixture';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Links the checkout's dependencies and packages under `<dir>/node_modules`. */
export async function linkWorkspace(dir: string): Promise<void> {
  const root = workspaceRoot();
  const modules = join(dir, 'node_modules');
  const scope = join(modules, '@ultimat3');
  mkdirSync(scope, { recursive: true });
  for (const entry of readdirSync(join(root, 'node_modules'))) {
    symlinkSync(join(root, 'node_modules', entry), join(modules, entry), DIR_LINK);
  }
  for (const entry of readdirSync(join(root, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = Bun.file(join(root, 'packages', entry.name, 'package.json'));
    if (!(await manifest.exists())) continue;
    const parsed: unknown = await manifest.json();
    const name = isRecord(parsed) && typeof parsed['name'] === 'string' ? parsed['name'] : '';
    if (!name.startsWith('@ultimat3/')) continue;
    symlinkSync(
      join(root, 'packages', entry.name),
      join(scope, name.slice('@ultimat3/'.length)),
      DIR_LINK,
    );
  }
}
