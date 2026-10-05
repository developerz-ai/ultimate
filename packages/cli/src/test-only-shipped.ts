// `package-shape`'s third rule of "test code does not ship": a `src/` module only tests (and
// fixtures) import is test code under a name `files` cannot see. The tarball excludes `*.test.ts`
// and `*-fixture.ts`, so a fake, a probe or a `bun:test` helper named anything else rode into
// every install — 20 of them across eleven packages until 2026-10. The defect is the name.

import { ERROR_DOCS_URL, renderFixShellArg } from '@ultimat3/core';
import type { ClosureHost } from './import-closure';
import { resolveSpec } from './import-closure';
import type { Finding } from './output';
import { FIXTURE_SUFFIX } from './publish-closure';
import { eachSourceFile, isGenerated, isTest } from './source-files';

/** A published package: its directory under `packages/` and the files its manifest names. */
export interface ShippedPackage {
  readonly dir: string;
  /** Package-relative (`src/index.ts`), and may be a glob (`src/icons/glyphs/*.ts`). */
  readonly entries: readonly string[];
}

export interface TestOnlyModule {
  readonly path: string;
  /** Every file that imports or names it — all of them tests, fixtures or test-only modules. */
  readonly importers: readonly string[];
}

/**
 * Every `src/` file a manifest names anywhere — `exports`, `bin`, the `browser` map, a `scripts`
 * command (`bun run src/icons/build-icons.ts`). Read off the whole document rather than field by
 * field: a module the manifest names is shipped on purpose, whichever field names it.
 */
export function entryPatternsOf(manifest: unknown): readonly string[] {
  const text = JSON.stringify(manifest ?? null);
  const found = [...text.matchAll(/(?:\.\/)?(src\/[\w./*-]+?\.tsx?)(?![\w.])/g)];
  return [...new Set(found.map((match) => match[1] ?? ''))].sort();
}

// Type-only imports count: the package ships `.ts` source, so a consumer's `tsc` opens the file a
// shipped `import type` names. One pattern for `from '.'`, `import('.')` and `import '.'`, relative
// specifiers only: over-matching an importer only ever clears a module, never flags one.
const RELATIVE = /(?:\bfrom|\bimport)\s*\(?\s*(['"])(\.\.?\/[^'"]*)\1/g;
/** A file named in a string — `join(import.meta.dir, 'probe.ts')`, `new URL('./worker.ts', …)`. */
const NAMED = /['"`/]([\w.-]+\.tsx?)['"`]/g;

/**
 * Whether the match at `index` sits on a line that IS a comment — `//`, a doc comment's `*`, a
 * `/*` opener. Line-wise and not core's `stripComments`, which is exact and costs ~1.1 s over the
 * repo's 6,000 files (measured 2026-10-05); asked only of a match, never of every line. The lines
 * this skips are where a commented-out or quoted-in-prose import lives, and one it keeps can only
 * clear a module, never flag one.
 */
function onCommentLine(text: string, index: number): boolean {
  let at = text.lastIndexOf('\n', index - 1) + 1;
  while (text[at] === ' ' || text[at] === '\t') at += 1;
  const head = text.slice(at, at + 2);
  return head === '//' || head === '/*' || head.startsWith('*');
}

const isFixture = (path: string): boolean => path.endsWith(FIXTURE_SUFFIX);
const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

const add = (map: Map<string, Set<string>>, key: string, value: string): void => {
  const set = map.get(key);
  if (set === undefined) map.set(key, new Set([value]));
  else set.add(value);
};

/** Who imports each file, and which files name each basename in a string. One pass per file. */
function referrersOf(sources: ReadonlyMap<string, string>): {
  readonly imports: ReadonlyMap<string, ReadonlySet<string>>;
  readonly named: ReadonlyMap<string, ReadonlySet<string>>;
} {
  const host: ClosureHost = { read: (path) => sources.get(path), alias: () => undefined };
  const imports = new Map<string, Set<string>>();
  const named = new Map<string, Set<string>>();
  for (const [from, text] of sources) {
    for (const match of text.matchAll(RELATIVE)) {
      if (onCommentLine(text, match.index)) continue;
      const target = resolveSpec(host, from, match[2] ?? '');
      if (target !== undefined && target !== from) add(imports, target, from);
    }
    for (const match of text.matchAll(NAMED)) {
      if (!onCommentLine(text, match.index)) add(named, match[1] ?? '', from);
    }
  }
  return { imports, named };
}

/**
 * The shipped `.ts` modules of the given packages whose every importer is a test, a fixture or
 * another such module — a greatest fixed point, so a helper only a fake imports is caught with the
 * fake. A module nobody references is not this rule's question, and an entry point is shipped by
 * definition. `.tsx` is not judged: `FIXTURE_EXCLUSION` matches `-fixture.ts` alone.
 */
export function testOnlyModules(
  sources: ReadonlyMap<string, string>,
  packages: readonly ShippedPackage[],
): readonly TestOnlyModule[] {
  const { imports, named } = referrersOf(sources);
  const entryGlobs = new Map(
    packages.map((pkg) => [
      pkg.dir,
      pkg.entries.map((entry) => new Bun.Glob(`packages/${pkg.dir}/${entry}`)),
    ]),
  );
  const referrers = new Map<string, ReadonlySet<string>>();
  for (const path of sources.keys()) {
    const dir = /^packages\/([^/]+)\/src\//.exec(path)?.[1];
    const globs = dir === undefined ? undefined : entryGlobs.get(dir);
    if (globs === undefined || !path.endsWith('.ts') || isGenerated(path)) continue;
    if (isTest(path) || isFixture(path) || globs.some((glob) => glob.match(path))) continue;
    const from = new Set([...(imports.get(path) ?? []), ...(named.get(baseName(path)) ?? [])]);
    from.delete(path);
    if (from.size > 0) referrers.set(path, from);
  }
  const testOnly = new Set(referrers.keys());
  const live = (path: string): boolean => !isTest(path) && !isFixture(path) && !testOnly.has(path);
  for (let changed = true; changed; ) {
    changed = false;
    for (const path of testOnly) {
      if (![...(referrers.get(path) ?? [])].some(live)) continue;
      testOnly.delete(path);
      changed = true;
    }
  }
  return [...testOnly].sort().map((path) => ({
    path,
    importers: [...(referrers.get(path) ?? [])].sort(),
  }));
}

/** `X_PACKAGE_TEST_ONLY_SHIPPED`, its fix the registered rename with the real paths in it. */
export const testOnlyShippedFinding = (module: TestOnlyModule): Finding => {
  const shown = module.importers.slice(0, 3).join(', ');
  const more = module.importers.length > 3 ? ` and ${module.importers.length - 3} more` : '';
  return {
    code: 'X_PACKAGE_TEST_ONLY_SHIPPED',
    cause: `${module.path} is imported only by tests and fixtures (${shown}${more}), and "files" publishes it — test scaffolding in every install`,
    fix: `git mv ${renderFixShellArg(module.path, '<the module above>')} ${renderFixShellArg(module.path.replace(/\.ts$/, FIXTURE_SUFFIX), '<its name>-fixture.ts')}   # and update its importers`,
    docs: ERROR_DOCS_URL,
    at: module.path,
    meta: { importers: [...module.importers] },
  };
};

/**
 * The rule over a repo on disk. Every source file is a possible importer — a script reading a
 * package's module by relative path is a shipped use of it — so the walk is the gate's own
 * (`eachSourceFile`), tests included. A repo with no published package reads nothing.
 */
export async function checkTestOnlyShipped(
  root: string,
  packages: readonly ShippedPackage[],
): Promise<readonly Finding[]> {
  if (packages.length === 0) return [];
  const paths: string[] = [];
  for await (const path of eachSourceFile(root)) if (!isGenerated(path)) paths.push(path);
  const texts = await Promise.all(paths.map((path) => Bun.file(`${root}/${path}`).text()));
  const sources = new Map(paths.map((path, index) => [path, texts[index] ?? '']));
  return testOnlyModules(sources, packages).map(testOnlyShippedFinding);
}
