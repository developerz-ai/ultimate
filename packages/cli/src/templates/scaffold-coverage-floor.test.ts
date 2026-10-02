// What `x new` writes about coverage: the floor in `x.verify.json`, the reason beside every
// exclude, and the rule in `AGENTS.md` — the three places an app's author meets the bar.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no path-join primitive; an emitted relative import is resolved against its file.
import { posix } from 'node:path';
import { planNewApp } from '../cmd-new';
import { COVERAGE_BAR } from '../coverage-floor';
import { hasExecutableCode, TEST_FILE } from '../coverage-source';
import { parseVerifyFloor, VERIFY_FLOOR_FILE } from '../verify-floor';
import { ownerOf } from '../verify-tests';
import { SCAFFOLD_COVERAGE_EXCLUDE } from './scaffold-repo';

const emitted = (path: string, example: boolean): string => {
  const file = planNewApp({ name: 'demo-app', example }).find((one) => one.path === path);
  if (file === undefined || typeof file.contents !== 'string') {
    return expect.unreachable(`x new writes no text file at ${path}`);
  }
  return file.contents;
};

describe('the floor a scaffolded app starts on', () => {
  for (const example of [true, false]) {
    test(`is the framework's own bar, with or without the example slice (${String(example)})`, () => {
      const floor = parseVerifyFloor(emitted(VERIFY_FLOOR_FILE, example));
      expect(floor.problems).toEqual([]);
      expect(floor.coverage?.lines).toBe(COVERAGE_BAR);
      expect(floor.coverage?.funcs).toBe(COVERAGE_BAR);
      // At the bar there is no `why` to owe: the reason is only for a floor under it.
      expect(floor.coverage?.why).toBeUndefined();
    });
  }

  test('every exclude says why a unit test cannot execute it, and names a file the app has', () => {
    const floor = parseVerifyFloor(emitted(VERIFY_FLOOR_FILE, true));
    expect(floor.coverage?.exclude).toEqual([...SCAFFOLD_COVERAGE_EXCLUDE]);
    const paths = planNewApp({ name: 'demo-app', example: true }).map((file) => file.path);
    for (const entry of SCAFFOLD_COVERAGE_EXCLUDE) {
      expect(entry.why.length).toBeGreaterThan(40);
      const glob = new Bun.Glob(entry.glob);
      expect(paths.some((path) => glob.match(path))).toBe(true);
    }
    // Never a test file, and never a whole surface: an exclude is for an entry point or a mount.
    const excluded = paths.filter((path) =>
      SCAFFOLD_COVERAGE_EXCLUDE.some((entry) => new Bun.Glob(entry.glob).match(path)),
    );
    expect(excluded.every((path) => /\.island\.tsx$|\/(?:server|prerender)\.ts$/.test(path))).toBe(
      true,
    );
  });
});

/**
 * The emitted files a unit run would LOAD: every unit test, and everything those import — followed
 * through relative specifiers and through the app's own workspace names, the two ways one emitted
 * file reaches another. A source file outside this set is one `x verify` counts at 0%.
 */
const loadedByUnitTests = (example: boolean): ReadonlySet<string> => {
  const files = new Map(
    planNewApp({ name: 'demo-app', example })
      .filter((file) => typeof file.contents === 'string')
      .map((file) => [file.path, String(file.contents)]),
  );
  const resolve = (from: string, specifier: string): string | undefined => {
    const base = specifier.startsWith('.')
      ? posix.join(posix.dirname(from), specifier)
      : specifier.startsWith('@demo-app/web/')
        ? `apps/web/${specifier.slice('@demo-app/web/'.length)}`
        : specifier.startsWith('@demo-app/')
          ? `packages/${specifier.slice('@demo-app/'.length)}/src/index`
          : undefined;
    if (base === undefined) return undefined;
    return [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((path) => files.has(path));
  };
  const loaded = new Set<string>();
  const visit = (path: string): void => {
    if (loaded.has(path)) return;
    loaded.add(path);
    const source = files.get(path) ?? '';
    // Static, side-effect and dynamic imports alike: `from '…'`, `import '…'`, `import('…')`.
    for (const match of source.matchAll(/(?:from\s+|import\s+|import\()'([^']+)'/g)) {
      const next = resolve(path, match[1] ?? '');
      if (next !== undefined) visit(next);
    }
  };
  for (const path of files.keys()) {
    if (TEST_FILE.test(path) && ownerOf(path) === 'unit') visit(path);
  }
  return loaded;
};

describe('what the scaffold writes is what its own unit suite loads', () => {
  for (const example of [true, false]) {
    test(`no emitted source file is one no emitted unit test reaches (example: ${String(example)})`, () => {
      const loaded = loadedByUnitTests(example);
      const excluded = SCAFFOLD_COVERAGE_EXCLUDE.map((entry) => new Bun.Glob(entry.glob));
      const unreached = planNewApp({ name: 'demo-app', example })
        .filter((file) => typeof file.contents === 'string')
        .filter((file) => /^(?:apps|packages)\/.*\.tsx?$/.test(file.path))
        .filter((file) => !TEST_FILE.test(file.path) && !file.path.endsWith('.d.ts'))
        .filter((file) => !excluded.some((glob) => glob.match(file.path)))
        // A barrel or a types-only module emits nothing and weighs nothing.
        .filter((file) => hasExecutableCode(String(file.contents)))
        .map((file) => file.path)
        .filter((path) => !loaded.has(path));
      // A file here counts at 0% in the app's first `x verify`: write its test in the template
      // that emits it — never an `exclude`, which is for code a unit test cannot execute.
      expect(unreached).toEqual([]);
    });
  }

  test('the walk follows what it claims to: a page reaches its repo, a seed reaches its schema', () => {
    const loaded = loadedByUnitTests(true);
    expect(loaded.has('apps/web/app/post/repo.ts')).toBe(true);
    expect(loaded.has('packages/db/src/schema.ts')).toBe(true);
    // And it does not reach what nothing imports: the container entry point stays outside.
    expect(loaded.has('apps/web/server.ts')).toBe(false);
  });
});

describe('AGENTS.md', () => {
  const agents = emitted('AGENTS.md', true);

  test('states the bar, what it is measured over, and what refuses a tree under it', () => {
    const row = agents.split('\n').find((line) => line.startsWith('| Coverage |')) ?? '';
    expect(row).toContain(`${String(COVERAGE_BAR)}% of the lines and functions`);
    expect(row).toContain('one no test loads counted at 0%');
    expect(row).toContain('X_COVERAGE_BELOW_FLOOR');
    expect(row).toContain('only rises');
  });

  test('carries the rule that makes the number mean something: proven by mutation', () => {
    expect(agents).toContain('proven by mutation — break the source, watch it go red, restore');
    expect(agents).toContain('worse than an uncovered one');
  });

  test('every test it says to copy from is a file the scaffold writes, with or without the example', () => {
    const cited = [...agents.matchAll(/`((?:apps|packages)\/[^`]+\.test\.ts)`/g)].map(
      (match) => match[1] ?? '',
    );
    // One per kind of thing an app tests: a page, a component, an island, an action, a seed.
    expect(cited.length).toBeGreaterThanOrEqual(5);
    for (const example of [true, false]) {
      const paths = planNewApp({ name: 'demo-app', example }).map((file) => file.path);
      for (const path of cited)
        expect({ example, path, written: paths.includes(path) }).toEqual({
          example,
          path,
          written: true,
        });
    }
    // And the two helpers the table names are the ones those files call.
    expect(emitted('apps/web/app/dashboard/page.test.ts', true)).toContain('renderRoute(page, {');
    expect(emitted('apps/web/shared/shell.test.ts', true)).toContain('renderView(Shell, {');
  });

  test('names every stylesheet guard the scaffold ships, each beside the file that refuses', () => {
    const guards = planNewApp({ name: 'demo-app', example: true })
      .map((file) => file.path)
      .filter((path) => /^guards\/[a-z-]+\.ts$/.test(path));
    expect(guards.length).toBeGreaterThan(10);
    for (const guard of guards) expect(agents).toContain(`\`${guard}\``);
  });
});
