// No two test files in this package build their fixture in the same directory. Under the gate's
// parallel workers two files sharing one root read each other's files mid-build:
// `prerender-budgets.test.ts` wrote a PWA `app.config.ts` into the root `prerender-islands.test.ts`
// also built, and a page that must ship no script carried `<script src="/x-sw-register.js">` —
// red in the full gate, green alone, green in CI. Read off the source, so it fails on every run.

import { expect, test } from 'bun:test';

/** `join(import.meta.dir, '..', '.name'[, 'sub'…])` — a fixture root inside the package. */
const ROOT_CALL = /join\(import\.meta\.dir,\s*'\.\.',\s*((?:'[^']+'(?:,\s*)?)+)\)/g;

test('every in-package fixture root belongs to exactly one test file', async () => {
  const owners = new Map<string, Set<string>>();
  for await (const file of new Bun.Glob('**/*.test.ts').scan({ cwd: import.meta.dir })) {
    const source = await Bun.file(`${import.meta.dir}/${file}`).text();
    for (const match of source.matchAll(ROOT_CALL)) {
      const root = (match[1] ?? '').replaceAll(/[\s']/g, '').split(',').join('/');
      if (!/^\.[a-z]/.test(root)) continue;
      const files = owners.get(root) ?? new Set<string>();
      files.add(file);
      owners.set(root, files);
    }
  }
  const shared = [...owners]
    .filter(([, files]) => files.size > 1)
    .map(([root, files]) => [root, [...files].sort()]);
  expect(owners.size).toBeGreaterThan(5);
  expect(shared).toEqual([]);
});
