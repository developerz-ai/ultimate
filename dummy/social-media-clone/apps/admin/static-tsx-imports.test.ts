// The rule the six conversions in this app now depend on: no test file under `apps/admin` may
// STATICALLY reach a `.tsx`. A static import is transformed while the graph is still loading —
// before `@ultimat3/render/server` can evaluate and install its `Bun.plugin` — so under
// `jsx: 'preserve'` Bun compiles the component against the classic `React.createElement`, caches
// that module for the whole process, and every later render in the same `bun test` run dies with
// `React is not defined`. `x verify --only unit` shards, so the poisoned cache never forms in one
// worker and the gate stayed green while `bun test` was red (issue #308). This file is the half
// that fails in both.

import { expect, test } from 'bun:test';

/** `apps/admin` — this file sits at the app root because its subject is the whole app. */
const ROOT = import.meta.dir;

/** `import { a } from './x';` — `import type` is erased, so it loads nothing and is not a reach. */
const IMPORT_FROM = /^(?:import|export)\s+(?!type\b)[\s\S]*?from\s*'([^']+)';/gm;
/** `import './x';` — a side-effect import loads the module just the same. */
const IMPORT_BARE = /^import\s*'([^']+)';/gm;

const specifiersIn = (source: string): readonly string[] => {
  const found: string[] = [];
  for (const match of source.matchAll(IMPORT_FROM))
    if (match[1] !== undefined) found.push(match[1]);
  for (const match of source.matchAll(IMPORT_BARE))
    if (match[1] !== undefined) found.push(match[1]);
  // Only this app's own modules: a framework package installs the loader on its own way in, and
  // its files are not what a test here can convert.
  return found.filter((specifier) => specifier.startsWith('.'));
};

/** `a/./b/../c` → `a/c`. The reported path is evidence, so it has to be one a reader can open. */
const normalize = (path: string): string => {
  const parts: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '.') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return parts.join('/');
};

/** `./admin` → `app/admin/admin.ts`; `./pages/ops` → `app/admin/pages/ops.tsx`. */
const resolveModule = async (fromDir: string, specifier: string): Promise<string | null> => {
  const base = normalize(`${fromDir}/${specifier}`);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (await Bun.file(candidate).exists()) return candidate;
  }
  return null;
};

/**
 * The first `.tsx` this file reaches without an `await import()` in between, or `null`. Depth-first
 * so the reported path is the shortest evidence a reader has to follow.
 */
const staticTsxUnder = async (entry: string, seen: Set<string>): Promise<string | null> => {
  if (seen.has(entry)) return null;
  seen.add(entry);
  const source = await Bun.file(entry).text();
  const dir = entry.slice(0, entry.lastIndexOf('/'));
  for (const specifier of specifiersIn(source)) {
    const resolved = await resolveModule(dir, specifier);
    if (resolved === null) continue;
    if (resolved.endsWith('.tsx')) return resolved;
    const deeper = await staticTsxUnder(resolved, seen);
    if (deeper !== null) return deeper;
  }
  return null;
};

const relative = (absolute: string): string => absolute.slice(ROOT.length + 1);

test('unit · no admin test statically reaches a .tsx — the loader would be too late', async () => {
  const offenders: string[] = [];
  const scanned: string[] = [];

  for await (const file of new Bun.Glob('**/*.test.ts').scan({ cwd: ROOT })) {
    if (file.includes('node_modules')) continue;
    const entry = `${ROOT}/${file}`;
    scanned.push(file);
    const reached = await staticTsxUnder(entry, new Set());
    if (reached !== null) {
      offenders.push(
        `${file} statically reaches ${relative(reached)} — replace that static import with ` +
          `\`await import('@ultimat3/render/server');\` followed by \`await import(<the module>)\``,
      );
    }
  }

  // The scan proves itself: a glob that matched nothing would report "no offenders" forever.
  expect(scanned.length).toBeGreaterThan(5);
  expect(offenders.sort()).toEqual([]);
});
