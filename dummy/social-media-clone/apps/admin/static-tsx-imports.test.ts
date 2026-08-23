// The rule the six conversions in this app now depend on: no test file under `apps/admin` may
// STATICALLY reach a `.tsx`. A static import is transformed while the graph is still loading —
// before `@ultimat3/render/server` can evaluate and install its `Bun.plugin` — so under
// `jsx: 'preserve'` Bun compiles the component against the classic `React.createElement`, caches
// that module for the whole process, and every later render in the same `bun test` run dies with
// `React is not defined`. `x verify --only unit` shards, so the poisoned cache never forms in one
// worker and the gate stayed green while `bun test` was red (issue #308). This file is the half
// that fails in both.

import { expect, test } from 'bun:test';
// `node:` and not Bun: Bun ships neither a temp-directory maker nor a recursive remove, and the
// fixture below needs both — a unique tree per run, deleted whole.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

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

/**
 * The files a specifier could name, in the order Bun would try them. A specifier carrying its own
 * extension names exactly ONE file — appending to `./pages/ops.tsx` probes `./pages/ops.tsx.ts`,
 * which is not a path Bun would ever try, so the bluntest form of the reach this file blocks read
 * as unresolvable and therefore clean. `./pages/ops.js` is TypeScript's ESM spelling of the same
 * `.ts`/`.tsx` file and Bun rewrites it; measured, both forms load a `.tsx` for real.
 */
const candidatesFor = (base: string): readonly string[] => {
  if (/\.tsx?$/.test(base)) return [base];
  const stem = base.replace(/\.jsx?$/, '');
  if (stem !== base) return [`${stem}.ts`, `${stem}.tsx`];
  return [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`];
};

/** `./admin` → `app/admin/admin.ts`; `./pages/ops` → `app/admin/pages/ops.tsx`. */
const resolveModule = async (fromDir: string, specifier: string): Promise<string | null> => {
  for (const candidate of candidatesFor(normalize(`${fromDir}/${specifier}`))) {
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

/** A tree on disk, because the scanner's subject is files. Deleted whole, pass or throw. */
const withFixture = async (
  files: Readonly<Record<string, string>>,
  run: (dir: string) => Promise<void>,
): Promise<void> => {
  const dir = await mkdtemp(`${tmpdir()}/ultimate-static-tsx-`);
  try {
    for (const [name, source] of Object.entries(files)) await Bun.write(`${dir}/${name}`, source);
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

test('unit · the scan detects the reach it exists to block — a dead scanner reads as clean', async () => {
  // The test above only proves the glob matched. If `IMPORT_FROM`, `normalize` or `candidatesFor`
  // stops matching, every file resolves to nothing, `offenders` stays empty and the rule is dead
  // under a green gate — the exact shape of issue #308, one layer up.
  await withFixture(
    {
      'pages/widget.tsx': 'export const widget = () => null;\n',
      'helper.ts': 'export const helper = 1;\n',
      'screen.ts': "import { widget } from './pages/widget';\nexport const screen = widget;\n",
      'transitive.test.ts': "import { screen } from './screen';\nexport const covered = screen;\n",
      'explicit.test.ts':
        "import { widget } from './pages/widget.tsx';\nexport const covered = widget;\n",
      'rewritten.test.ts':
        "import { widget } from './pages/widget.js';\nexport const covered = widget;\n",
      'dynamic.test.ts':
        "import { helper } from './helper';\n" +
        "export const covered = async () => await import('./pages/widget');\nexport const n = helper;\n",
      'erased.test.ts':
        "import type { widget } from './pages/widget';\n" +
        "import { helper } from './helper';\nexport const n = helper;\n",
    },
    async (dir) => {
      const reach = async (file: string) => await staticTsxUnder(`${dir}/${file}`, new Set());
      // Every static spelling of the reach, including through a `.ts` hop.
      expect(await reach('transitive.test.ts')).toBe(`${dir}/pages/widget.tsx`);
      expect(await reach('explicit.test.ts')).toBe(`${dir}/pages/widget.tsx`);
      expect(await reach('rewritten.test.ts')).toBe(`${dir}/pages/widget.tsx`);
      // And the two spellings that are the FIX — a scanner flagging either makes the rule
      // unfollowable. Both keep a resolvable `.ts` edge, so `null` is a verdict and not silence.
      expect(await reach('dynamic.test.ts')).toBeNull();
      expect(await reach('erased.test.ts')).toBeNull();
    },
  );
});
