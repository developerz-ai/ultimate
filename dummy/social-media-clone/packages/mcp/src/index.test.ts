// The boundary every package under `packages/` declares in its own CLAUDE.md and nothing enforced:
// "never a sibling app". `x verify`'s `boundaries` step cannot see this — `readAppSources` globs
// `apps/*/{site,app,api,shared}/**` and stops there (packages/cli/src/app-boundaries.ts) — so a
// package importing up into the application that consumes it was invisible to the gate. It shipped:
// this file's own module imported `@social-media-clone/web/api/health`.

import { expect, test } from 'bun:test';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../../..');

/** Derived, never listed: a new app under `apps/` is covered the moment it exists. */
const appNames = async (): Promise<readonly string[]> => {
  const names: string[] = [];
  for await (const entry of new Bun.Glob('apps/*/package.json').scan({ cwd: ROOT })) {
    const name = entry.split('/')[1];
    if (name !== undefined) names.push(name);
  }
  return names;
};

/**
 * Every form the specifier can arrive in: `from '…'`, a bare side-effect `import '…'`, and a
 * dynamic `import('…')`. The first spelling alone is what an earlier version of this test matched,
 * and a side-effect import is exactly how a module gets pulled in for its registrations — which is
 * the shape the violation this file exists for would take if it came back.
 */
const importedSpecifiers = (source: string): readonly string[] =>
  [...source.matchAll(/\b(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map(
    (match) => match[1] ?? '',
  );

test('no package under packages/ imports a sibling app', async () => {
  const apps = await appNames();
  expect(apps.length).toBeGreaterThan(0);

  const reaches = (specifier: string): boolean =>
    apps.some(
      (app) =>
        specifier === `@social-media-clone/${app}` ||
        specifier.startsWith(`@social-media-clone/${app}/`),
    ) || /(^|\/)apps\//.test(specifier);

  const offenders: string[] = [];
  for await (const file of new Bun.Glob('packages/*/src/**/*.{ts,tsx}').scan({ cwd: ROOT })) {
    // A test may reach an app — `loadApp` boots one two files over. The RULE is about the code
    // that ships: a package's source is imported by every app, so an app in its graph is a cycle.
    if (file.includes('.test.')) continue;
    const source = await Bun.file(resolve(ROOT, file)).text();
    for (const specifier of importedSpecifiers(source)) {
      if (reaches(specifier)) offenders.push(`${file} → ${specifier}`);
    }
  }
  expect(offenders).toEqual([]);
});
