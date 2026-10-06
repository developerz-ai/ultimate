// No two test files build their fixture in the same directory, and no two PROCESSES do either.
// Under the gate's parallel workers two files sharing one root read each other's files mid-build:
// `prerender-budgets.test.ts` wrote a PWA `app.config.ts` into the root `prerender-islands.test.ts`
// also built, and a page that must ship no script carried `<script src="/x-sw-register.js">`. And
// two processes running ONE file at once in one checkout (two gate runs, two agents' `bun test`)
// shared its fixed root: a peer's `rm` deleted `island-determinism.test.ts`'s tree mid-build
// (`ENOENT: failed to open root directory`), and `prerender-actor.test.ts`'s export found the
// peer's files in `static/` (X_BUILD_OUT_UNSAFE). Both read off the source, so they fail every run.

import { expect, test } from 'bun:test';
// why: Bun exposes no path API — nothing native joins a directory to a file.
import { join } from 'node:path';

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

/** `packages/cli/src` → the repo root. */
const REPO_ROOT = join(import.meta.dir, '..', '..', '..');

/** Every file that builds fixtures: tests and the `*-fixture.ts` helpers they share. */
const SCANNED = ['packages/*/{src,e2e}/**/*.test.ts', 'packages/*/src/**/*-fixture.ts'];

/** A path segment naming a fixture directory: `'.x-fixture'`, `'.tmp'`, or `` `.${name}` ``. */
const FIXTURE_SEGMENT = /(?:['`]\.(?:tmp|[a-z][\w-]*-fixture)['`/-]|`\.\$\{)/;

/** What makes a path this process's own, inside the `join(…)` or wrapped around it. */
const PER_PROCESS_ARG = /process\.pid|randomUUID/;
const PER_PROCESS_WRAP = /(?:processRoot|mkdtemp|mkdtempSync)\($/;

/**
 * Paths no test ever creates — the argument to a "this does not exist" assertion — so there is
 * nothing on disk for two processes to share. Each is `file: the join's own text`.
 */
const NEVER_CREATED = new Set([
  "packages/cli/src/cmd-generate.test.ts: tmpdir(), 'x-generate-absolute-probe.ts'",
  "packages/manifest/src/docs-scan.test.ts: tmpdir(), 'ultimate-docs-absent-scope'",
]);

/** The text of each `join(…)` call in `source`, balanced over nested parentheses. */
function joinCalls(source: string): readonly { readonly at: number; readonly args: string }[] {
  const calls: { at: number; args: string }[] = [];
  for (let at = source.indexOf('join('); at !== -1; at = source.indexOf('join(', at + 1)) {
    if (/[\w.]/.test(source[at - 1] ?? '')) continue;
    let depth = 0;
    for (let end = at + 4; end < source.length; end += 1) {
      if (source[end] === '(') depth += 1;
      else if (source[end] === ')' && --depth === 0) {
        calls.push({
          at,
          args: source
            .slice(at + 5, end)
            .replaceAll(/\s+/g, ' ')
            .trim(),
        });
        break;
      }
    }
  }
  return calls;
}

test('every fixture root a test builds is one process’s: processRoot, mkdtemp or pid', async () => {
  const fixed: string[] = [];
  let seen = 0;
  for (const pattern of SCANNED) {
    for await (const file of new Bun.Glob(pattern).scan({ cwd: REPO_ROOT })) {
      const source = await Bun.file(join(REPO_ROOT, file)).text();
      for (const { at, args } of joinCalls(source)) {
        if (!FIXTURE_SEGMENT.test(args) && !args.startsWith('tmpdir()')) continue;
        seen += 1;
        if (PER_PROCESS_ARG.test(args) || PER_PROCESS_WRAP.test(source.slice(0, at).trimEnd())) {
          continue;
        }
        if (NEVER_CREATED.has(`${file}: ${args}`)) continue;
        const line = source.slice(0, at).split('\n').length;
        fixed.push(`${file}:${String(line)} join(${args})`);
      }
    }
  }
  // Read off the source, so a scan that matched nothing is a broken scan, not a clean tree.
  expect(seen).toBeGreaterThan(50);
  expect(fixed.sort()).toEqual([]);
});
